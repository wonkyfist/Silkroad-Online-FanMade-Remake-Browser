/**
 * TP-P PBR derivation (docs/TEXPIPE.md §3.5–3.7 and TP-P tests, docs/WAVE_PLAN3.md §7.1 TP-P, docs/DETAIL.md L3).
 * Synthetic images only, no game data: paraboloid normals within 1°; tileable in → tileable out; specmask → metallic
 * (with the corrected specmask rule); cutout height 0 outside; island dilation; de-light k = 0 is the identity; plus
 * the pieces (masks, detail tiles, packing, PNG, overrides, the worker pool).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classParams } from '../../world-render/src/pbr/classes.ts'
import { MASK_CLASSES, MASK_NONE, ORMH, validateOverrides } from '../src/format.ts'
import { alphaKind } from '../src/inventory.ts'
import { delight } from '../src/pbr/delight.ts'
import { derive, type DeriveInput } from '../src/pbr/derive.ts'
import { detailTile, fbm, worley } from '../src/pbr/detail.ts'
import { HEIGHT_MIN_RANGE, heightMap, normaliseRange } from '../src/pbr/height.ts'
import { blur, blurBuffer, clone, img, luminance, NO_WRAP, regionBlur, roll, seamRatio, wholeRegion, type Img } from '../src/pbr/image.ts'
import { encodePng, readImage } from '../src/pbr/io.ts'
import { fillFrom, gutterBand, nearestOwner, rasterIslands } from '../src/pbr/islands.ts'
import { runJob, type PbrJob } from '../src/pbr/job.ts'
import { classifyCentroid, materialMasks, smallMetal } from '../src/pbr/masks.ts'
import { angleDeg, normalFromHeight } from '../src/pbr/normal.ts'
import { packOrmh } from '../src/pbr/ormh.ts'
import { MASK_PARAMS, PROFILE_PARAMS, profileOf, resolveParams, surfaceUp, type DeriveMeta } from '../src/pbr/params.ts'
import { puddleFlatness, shade, wetExposure } from '../src/pbr/preview.ts'
import { runPool } from '../src/pbr/pool.ts'

// ---- helpers ------------------------------------------------------------------------------------------------------------

/** Deterministic noise in 0..1. */
function noise(w: number, h: number, seed: number): Float32Array {
  let s = seed >>> 0
  return Float32Array.from({ length: w * h }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  })
}

/** A tileable textured RGBA image (wrap-blurred noise at two scales, a stone-like grey-brown). */
function tileable(w: number, h: number, seed = 1, wrap: [boolean, boolean] = [true, true]): Img {
  const edges = [wrap[0] ? 'wrap' : 'clamp', wrap[1] ? 'wrap' : 'clamp'] as const
  const a = blurBuffer(noise(w, h, seed), w, h, 1.2, edges)
  const b = blurBuffer(noise(w, h, seed + 7), w, h, 5, edges)
  const o = img(w, h, 4)
  for (let p = 0; p < w * h; p++) {
    const v = 0.35 + 1.6 * (a[p]! - 0.5) + 5 * (b[p]! - 0.5)
    o.d[p * 4] = Math.min(1, Math.max(0, v * 1.05))
    o.d[p * 4 + 1] = Math.min(1, Math.max(0, v * 0.95))
    o.d[p * 4 + 2] = Math.min(1, Math.max(0, v * 0.85))
    o.d[p * 4 + 3] = 1
  }
  return o
}

function meta(over: Partial<DeriveMeta>): DeriveMeta {
  return { key: 'prim/mtrl/bldg/test/stone_a.ddj', group: 'world', class: 'stone', alpha: 'none', wrap: [true, true], sourceSize: [32, 32], ...over }
}

const run = (inp: Partial<DeriveInput> & { albedo: Img; meta: DeriveMeta }) => derive({ previewEdge: 0, ...inp })

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return m
}

// ---- the TP-P test list -------------------------------------------------------------------------------------------------

describe('TP-P derivation', () => {
  it('a paraboloid height field gives normals within 1° of analytic', () => {
    const w = 160, h = 160, cx = 79.5, cy = 83.25, a = 1 / 9000
    const H = img(w, h, 1)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H.d[y * w + x] = a * ((x - cx) ** 2 + (y - cy) ** 2)
    for (const [strength, scale] of [[1.5, 4], [3, 2], [4, 1]] as const) {
      const n = normalFromHeight(H, strength, scale, NO_WRAP, null)
      // n = normalize(−F·2·∂H/∂x, +F·2·∂H/∂y, 1), F = 2 · scale · strength (0.5 fine + 1.5 medium scale, both exact on a
      // quadratic away from the border: blur(H) of a quadratic is the quadratic plus a constant).
      const F = 2 * scale * strength
      const ref = img(w, h, 3)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const nx = -F * 2 * (2 * a * (x - cx)), ny = F * 2 * (2 * a * (y - cy))
          const l = Math.hypot(nx, ny, 1)
          const p = y * w + x
          ref.d[p * 3] = nx / l
          ref.d[p * 3 + 1] = ny / l
          ref.d[p * 3 + 2] = 1 / l
        }
      }
      const margin = Math.ceil(3 * 2 * scale) + 3
      let worst = 0, tilted = 0
      for (let y = margin; y < h - margin; y++) {
        for (let x = margin; x < w - margin; x++) {
          worst = Math.max(worst, angleDeg(n, ref, y * w + x))
          tilted = Math.max(tilted, Math.acos(ref.d[(y * w + x) * 3 + 2]!) * 180 / Math.PI)
        }
      }
      expect(worst).toBeLessThan(1)
      expect(tilted).toBeGreaterThan(10)
    }
  })

  it('a tileable input gives a tileable output on its wrap axes (seam ratio ≤ 1.2, translation-equivariant)', () => {
    const w = 128, h = 128
    const src = tileable(w, h, 3)
    const r = run({ albedo: src, meta: meta({}) })
    for (const axis of ['u', 'v'] as const) {
      expect(seamRatio(src, axis)).toBeLessThan(1.2)
      expect(seamRatio(r.albedo, axis)).toBeLessThan(1.2)
      expect(seamRatio(r.normal, axis)).toBeLessThan(1.2)
      expect(seamRatio(r.ormh, axis, [0, 1, 3])).toBeLessThan(1.2)
    }
    // The strong form: every stage is wrap-local or uses global statistics, so shifting the input shifts the output.
    const dx = 37, dy = 53
    const shifted = run({ albedo: roll(src, dx, dy), meta: meta({}) })
    expect(maxDiff(shifted.albedo.d, roll(r.albedo, dx, dy).d)).toBeLessThan(2e-3)
    expect(maxDiff(shifted.normal.d, roll(r.normal, dx, dy).d)).toBeLessThan(2e-3)
    expect(maxDiff(shifted.ormh.d, roll(r.ormh, dx, dy).d)).toBeLessThan(2e-3)
    // A U-only texture (the city wall) stays seamless along U.
    const wall = tileable(64, 128, 5, [true, false])
    const rw = run({ albedo: wall, meta: meta({ key: 'prim/mtrl/bldg/x/cj_wall01.ddj', wrap: [true, false], sourceSize: [16, 32] }) })
    expect(rw.info.profile).toBe('wall')
    expect(seamRatio(rw.normal, 'u')).toBeLessThan(1.2)
    expect(seamRatio(rw.ormh, 'u', [0, 1, 3])).toBeLessThan(1.2)
  })

  it('specmask → metallic, with the corrected specmask rule (the Copper Sword)', () => {
    // The inventory rule: the Copper Sword is OPAQUE with the equipment verdict (no "spec" in it), BLEND in its drop copy.
    const kind = alphaKind({
      alphaModes: ['OPAQUE', 'BLEND'], format: 'DXT3', alphaMin: 0,
      alphaReasons: ['equipment: BMT alpha flag but 79% of the surface samples alpha < 128 (0% zero): the alpha is a mask', 'BMT alpha flag; texture alpha mostly partial'],
    })
    expect(kind).toBe('specmask')
    // A metal atlas whose alpha ramps 0 → 1 across U: metallic follows the mask (× 1.6, clamped), roughness drops.
    const w = 96, h = 32
    const base = tileable(w, h, 9, [false, false])
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) base.d[(y * w + x) * 4 + 3] = x / (w - 1)
    const sword = meta({ key: 'prim/mtrl/item/china/weapon/sword1_2_3.ddj', group: 'equipment', class: 'metal', alpha: kind, wrap: [false, false], sourceSize: [24, 8] })
    const r = run({ albedo: base, meta: sword, options: { masks: false } })
    const metal = (x: number) => r.ormh.d[(16 * w + x) * 4 + ORMH.metal]!
    expect(metal(0)).toBeLessThan(0.02)
    expect(metal(30)).toBeCloseTo(Math.min(1, 1.6 * (30 / (w - 1))), 1)
    expect(metal(80)).toBeGreaterThan(0.99)
    let roughLo = 0, roughHi = 0
    for (let y = 0; y < h; y++) {
      roughLo += r.ormh.d[(y * w + 5) * 4 + ORMH.rough]!
      roughHi += r.ormh.d[(y * w + 90) * 4 + ORMH.rough]!
    }
    expect(roughHi).toBeLessThan(roughLo - 0.2 * h)
    // The spec mask is not shipped as alpha.
    expect(r.albedo.d[(16 * w + 10) * 4 + 3]).toBe(1)
    // Without a mask alpha: the metal class gets its class metallic, stone none.
    const flat = clone(base)
    for (let p = 0; p < w * h; p++) flat.d[p * 4 + 3] = 1
    expect(run({ albedo: flat, meta: { ...sword, alpha: 'none' }, options: { masks: false } }).ormh.d[(16 * w + 40) * 4 + ORMH.metal]).toBeCloseTo(classParams('metal').metallic, 5)
    expect(run({ albedo: flat, meta: meta({ wrap: [false, false], sourceSize: [24, 8] }) }).ormh.d[(16 * w + 40) * 4 + ORMH.metal]).toBe(0)
  })

  it('specmask on an armour atlas with material masks: iron is metallic, leather only glossier', () => {
    const w = 128, h = 64
    const n = noise(w, h, 21)
    const im = img(w, h, 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, j = 0.06 * (n[p]! - 0.5)
        const iron = x < w / 2
        const c = iron ? [0.58, 0.59, 0.62] : [0.45, 0.28, 0.16]
        for (let k = 0; k < 3; k++) im.d[p * 4 + k] = c[k]! + j
        im.d[p * 4 + 3] = iron ? 0.95 : 0.12
      }
    }
    const armour = meta({ key: 'prim/mtrl/item/china/man_item/heavy_01_ba.ddj', group: 'equipment', class: 'default', alpha: 'specmask', wrap: [false, false], sourceSize: [32, 16] })
    const r = run({ albedo: im, meta: armour })
    expect(r.info.profile).toBe('armour')
    expect(r.classMask).not.toBeNull()
    const at = (x: number, y: number) => (y * w + x) * 4
    expect(r.ormh.d[at(20, 32) + ORMH.metal]).toBeGreaterThan(0.7)
    expect(r.ormh.d[at(100, 32) + ORMH.metal]).toBeLessThan(0.1)
    expect(MASK_CLASSES[r.classMask![32 * w + 20]!]).toBe('metal')
    expect(MASK_CLASSES[r.classMask![32 * w + 100]!]).toBe('leather')
    // Iron plates stand out of the leather (the DETAIL bevel): the iron side is higher on average.
    let hi = 0, lo = 0
    for (let y = 8; y < h - 8; y++) for (let x = 8; x < 56; x++) { hi += r.ormh.d[at(x, y) + ORMH.height]!; lo += r.ormh.d[at(x + 64, y) + ORMH.height]! }
    expect(hi).toBeGreaterThan(lo)
  })

  it('a cutout gets height 0 outside its mask (and keeps its alpha)', () => {
    const w = 96, h = 96
    const leaf = tileable(w, h, 4, [false, false])
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = Math.hypot(x - 48, y - 48) < 30
        leaf.d[(y * w + x) * 4 + 3] = inside ? 1 : 0
        if (!inside) for (let k = 0; k < 3; k++) leaf.d[(y * w + x) * 4 + k] = k === 0 ? 1 : 0 // a red matte
      }
    }
    const r = run({ albedo: leaf, meta: meta({ key: 'prim/mtrl/nature/common/tree/tre_tree02_01.ddj', class: 'foliage', alpha: 'cutout', wrap: [false, false], sourceSize: [24, 24] }) })
    let outside = 0, inside = 0
    for (let p = 0; p < w * h; p++) {
      if (leaf.d[p * 4 + 3]! < 0.5) {
        expect(r.ormh.d[p * 4 + ORMH.height]).toBe(0)
        expect(r.albedo.d[p * 4 + 3]).toBe(0)
        outside++
      } else inside = Math.max(inside, r.ormh.d[p * 4 + ORMH.height]!)
    }
    expect(outside).toBeGreaterThan(1000)
    expect(inside).toBeGreaterThan(0.5)
    // The red matte is gone: the transparent texels carry the nearest leaf colour (no fringe in the mips).
    expect(r.albedo.d[(2 * w + 2) * 4]).toBeLessThan(0.9)
  })

  it('island dilation: no texel of island A within 8 px of island B, and B never sees A', () => {
    const w = 128, h = 64
    // Two rectangles in UV (two triangles each), 8 texels apart: A x 8..56, B x 64..120.
    const rect = (x0: number, x1: number) => {
      const [u0, u1, v0, v1] = [x0 / w, x1 / w, 8 / h, 56 / h]
      return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]
    }
    const islands = rasterIslands(Float64Array.from([...rect(8, 56), ...rect(64, 120)]), w, h)
    expect(islands.count).toBe(2)
    const make = (aSeed: number, aTone: number) => {
      const im = tileable(w, h, 11, [false, false])
      const na = noise(w, h, aSeed)
      for (let y = 0; y < h; y++) for (let x = 0; x < 60; x++) for (let k = 0; k < 3; k++) im.d[(y * w + x) * 4 + k] = aTone + 0.2 * na[y * w + x]!
      return im
    }
    const m = meta({ key: 'prim/mtrl/item/china/man_item/clothes_01_ba.ddj', group: 'equipment', class: 'cloth', wrap: [false, false], sourceSize: [32, 16] })
    const r1 = run({ albedo: make(1, 0.8), meta: m, islands, options: { masks: false } })
    const r2 = run({ albedo: make(2, 0.05), meta: m, islands, options: { masks: false } })
    // B's texels (and the gutter texels nearest B) do not depend on A's content.
    const owner = nearestOwner(islands.ids, w, h)
    expect(r1.info.islands).toBe(2)
    let checked = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const own = owner[p]!
        if (islands.ids[own] !== 1) continue
        if (Math.max(Math.abs((own % w) - x), Math.abs(Math.floor(own / w) - y)) > gutterBand(w, h)) continue // B and its band
        for (const [a, b] of [[r1.albedo, r2.albedo], [r1.normal, r2.normal], [r1.ormh, r2.ormh]] as const) {
          for (let k = 0; k < a.c; k++) expect(Math.abs(a.d[p * a.c + k]! - b.d[p * b.c + k]!)).toBeLessThan(1e-5)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(56 * 48)
    // (The unclaimed art around both islands is one region of its own, so it may see A: it is not B.)
    // Gutter-band texels take their nearest island's texel: within 8 px of B (and nearer B) nothing comes from A.
    const aEnd = Math.max(...Array.from({ length: w }, (_, x) => (islands.ids[32 * w + x] === 0 ? x : -1)))
    const bStart = Array.from({ length: w }, (_, x) => x).find(x => islands.ids[32 * w + x] === 1)!
    expect(bStart - aEnd).toBeGreaterThanOrEqual(6)
    const band = gutterBand(w, h)
    for (let y = 10; y < 54; y++) {
      for (let x = aEnd + 1; x < bStart; x++) {
        const p = y * w + x
        const dA = x - aEnd, dB = bStart - x
        if (Math.min(dA, dB) > band) continue
        expect(islands.ids[owner[p]!]).toBe(dB < dA ? 1 : 0)
        for (const im of [r1.albedo, r1.normal, r1.ormh]) {
          for (let k = 0; k < im.c; k++) expect(im.d[p * im.c + k]).toBe(im.d[owner[p]! * im.c + k])
        }
      }
    }
    // Beyond the band the atlas keeps its own art (no converted glb samples it, an unconverted one might): the far
    // corner is not a copy of an island texel, and it is only de-lit, not replaced.
    expect(r1.info.unclaimed).toBeGreaterThan(0)
    const src = make(1, 0.8)
    expect(Math.abs(r1.albedo.d[(2 * w + 124) * 4]! - src.d[(2 * w + 124) * 4]!)).toBeLessThan(0.15)
    expect(r1.albedo.d[(2 * w + 124) * 4]).not.toBe(r1.albedo.d[owner[2 * w + 124]! * 4])
  })

  it('de-light with k = 0 is the identity (and k > 0 flattens a painted gradient)', () => {
    const w = 64, h = 64
    const src = tileable(w, h, 6, [false, false])
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) src.d[(y * w + x) * 4 + k] *= 0.4 + 0.6 * (x / w)
    const same = delight(src, 0, NO_WRAP, null)
    expect(maxDiff(same.d, src.d)).toBe(0)
    const viaDerive = run({ albedo: src, meta: meta({ wrap: [false, false], sourceSize: [16, 16] }), override: { delight: 0 } })
    for (let p = 0; p < w * h; p++) for (let k = 0; k < 3; k++) expect(viaDerive.albedo.d[p * 4 + k]).toBe(src.d[p * 4 + k])
    // k = 0.8: the left/right brightness ratio moves towards 1.
    const flat = delight(src, 0.8, NO_WRAP, null)
    const side = (im: Img, x0: number) => {
      let s = 0
      for (let y = 0; y < h; y++) for (let x = x0; x < x0 + 8; x++) s += im.d[(y * w + x) * 4 + 1]!
      return s
    }
    expect(side(flat, 0) / side(flat, 56)).toBeGreaterThan(side(src, 0) / side(src, 56) + 0.1)
  })
})

// ---- the pieces --------------------------------------------------------------------------------------------------------

describe('pieces', () => {
  it('blurs: box and Gaussian paths keep the mean; wrap blurs stay tileable; region blur ignores other regions', () => {
    const w = 64, h = 48
    const n = { w, h, c: 1, d: noise(w, h, 3) }
    for (const s of [0.8, 1.5, 4, 12]) {
      const b = blur(n, s, [true, true])
      const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length
      expect(mean(b.d)).toBeCloseTo(mean(n.d), 4)
      expect(seamRatio(b, 'u', [0])).toBeLessThan(1.3)
    }
    const r = wholeRegion(w, h, p => p % w < 32)
    const x = clone(n)
    for (let p = 0; p < w * h; p++) if (p % w >= 32) x.d[p] = 100
    const a = regionBlur(x, 6, NO_WRAP, r)
    for (let p = 0; p < w * h; p++) if (p % w < 32) expect(a.d[p]!).toBeLessThan(1)
  })

  it('profiles pick TEXPIPE factors inside one class; actors cap de-light; masks only on actor atlases', () => {
    expect(profileOf('tile2d:c_marble_jang_09', 'stone')).toBe('paving')
    expect(profileOf('tile2d:c_stone_hmfld_01', 'stone')).toBe('rock')
    expect(profileOf('prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj', 'stone')).toBe('wall')
    expect(profileOf('prim/mtrl/nature/common/tree/tre_bank_pilla.ddj', 'foliage')).toBe('bark')
    expect(profileOf('prim/mtrl/char/china/man/chinaman_adventurer_hair.ddj', 'default')).toBe('hair')
    const body = resolveParams(meta({ key: 'prim/mtrl/char/china/man/chinaman_adventurer_body.ddj', group: 'char', class: 'skin', alpha: 'cutout', wrap: [false, false], sourceSize: [512, 256] }), [2048, 1024])
    expect(body.scale).toBe(4)
    expect(body.delight).toBeLessThanOrEqual(0.3)
    expect(body.masks?.kind).toBe('body')
    expect(body.detail).toBe(1)
    const tile = resolveParams(meta({ key: 'tile2d:c_grass_fld_03', group: 'tile', class: 'ground_grass', sourceSize: [512, 512] }), [2048, 2048])
    expect(tile.masks).toBeNull()
    expect(tile.delight).toBe(0.8)
    expect(tile.delit).toBe(true)
    const noDetail = resolveParams(meta({ key: 'prim/mtrl/item/china/weapon/sword1_2_3.ddj', group: 'equipment', class: 'metal', wrap: [false, false] }), [128, 128], { detail: 0 })
    expect(noDetail.detail).toBe(0)
  })

  it('material masks: colour rules name the clusters; a relabel fixes one (the grip → wood)', () => {
    expect(classifyCentroid(60, 1, 2, 0.8, true, ['metal', 'gold', 'leather', 'cloth'], 'leather')).toBe('metal')
    expect(classifyCentroid(70, 5, 60, 0.6, true, ['metal', 'gold', 'leather', 'cloth'], 'leather')).toBe('gold')
    expect(classifyCentroid(40, 12, 25, 0, false, ['cloth', 'leather'], 'leather')).toBe('leather')
    expect(classifyCentroid(10, 0, 0, 0, false, ['cloth', 'leather'], 'leather')).toBeNull()
    expect(classifyCentroid(85, 0, 2, 0, false, ['cloth', 'leather'], 'leather')).toBe('cloth')
    const w = 64, h = 32
    const im = img(w, h, 4)
    const n = noise(w, h, 5)
    for (let p = 0; p < w * h; p++) {
      const left = p % w < 32
      const c = left ? [0.85, 0.84, 0.8] : [0.42, 0.26, 0.14]
      for (let k = 0; k < 3; k++) im.d[p * 4 + k] = c[k]! + 0.04 * (n[p]! - 0.5)
      im.d[p * 4 + 3] = 1
    }
    const m = materialMasks({ albedo: im, scale: 2, regions: null, spec: false, allowed: ['cloth', 'leather', 'gold', 'metal'], olive: 'leather' })
    expect(MASK_CLASSES[m.index[16 * w + 8]!]).toBe('cloth')
    expect(MASK_CLASSES[m.index[16 * w + 56]!]).toBe('leather')
    const leatherCluster = m.clusters[8 * 32 + 28]!
    const fixed = materialMasks({ albedo: im, scale: 2, regions: null, spec: false, allowed: ['cloth', 'leather', 'gold', 'metal'], olive: 'leather', relabel: { [String(leatherCluster)]: 'wood' } })
    expect(MASK_CLASSES[fixed.index[16 * w + 56]!]).toBe('wood')
    // Deterministic.
    expect(Array.from(materialMasks({ albedo: im, scale: 2, regions: null, spec: false, allowed: ['cloth', 'leather'], olive: 'leather' }).index))
      .toEqual(Array.from(materialMasks({ albedo: im, scale: 2, regions: null, spec: false, allowed: ['cloth', 'leather'], olive: 'leather' }).index))
  })

  it('small metal: a bright grey rivet on leather counts, the bright side of an edge does not', () => {
    const w = 96, h = 64, scale = 4
    const im = img(w, h, 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        const rivet = Math.hypot(x - 24, y - 32) < 4
        // Left: brown leather with a grey rivet; right: a white field meeting a dark trim at x = 72.
        const c = x < 48 ? (rivet ? [0.72, 0.72, 0.74] : [0.4, 0.24, 0.13]) : x < 72 ? [0.85, 0.85, 0.83] : [0.2, 0.22, 0.15]
        for (let k = 0; k < 3; k++) im.d[p * 4 + k] = c[k]!
        im.d[p * 4 + 3] = 1
      }
    }
    const f = smallMetal(im, scale)
    expect(f[32 * w + 24]).toBeGreaterThan(0.5)
    for (let x = 60; x < 72; x++) expect(f[32 * w + x]).toBeLessThan(0.1)
  })

  it('detail tiles are tileable, deterministic, and their albedo multiplier averages 1', () => {
    const f1 = fbm(64, 3, 4, 7), f2 = fbm(64, 3, 4, 7)
    expect(maxDiff(f1, f2)).toBe(0)
    expect(seamRatio({ w: 64, h: 64, c: 1, d: f1 }, 'u', [0])).toBeLessThan(1.3)
    const wy = worley(64, 8, 3)
    expect(seamRatio({ w: 64, h: 64, c: 1, d: wy.F1 }, 'v', [0])).toBeLessThan(1.5)
    for (const c of MASK_CLASSES) {
      const t = detailTile(c, 128)
      const hImg = { w: 128, h: 128, c: 1, d: t.h }
      expect(seamRatio(hImg, 'u', [0])).toBeLessThan(1.6)
      expect(seamRatio(hImg, 'v', [0])).toBeLessThan(1.6)
      expect(t.alb.reduce((a, b) => a + b, 0) / t.alb.length).toBeCloseTo(1, 4)
      expect(detailTile(c, 128)).toBe(t)
    }
  })

  it('ORMH is packed in the D37 order (R AO, G rough, B metal, A height)', () => {
    const o = packOrmh({ ao: Float32Array.of(0.1), rough: Float32Array.of(0.2), metal: Float32Array.of(0.3), height: Float32Array.of(0.4) }, 1, 1)
    expect(Array.from(o.d).map(v => Math.round(v * 10) / 10)).toEqual([0.1, 0.2, 0.3, 0.4])
    expect([ORMH.ao, ORMH.rough, ORMH.metal, ORMH.height]).toEqual([0, 1, 2, 3])
  })

  it('16-bit PNG masters round-trip through sharp', async () => {
    const im = img(5, 3, 4)
    for (let i = 0; i < im.d.length; i++) im.d[i] = (i * 7919 % 65536) / 65535
    const back = await readImage(encodePng(im, 16))
    expect(back.w).toBe(5)
    expect(maxDiff(back.d, im.d)).toBeLessThan(1 / 65535 + 1e-7)
    const grey = await readImage(encodePng(im, 8, [1]))
    expect(Math.abs(grey.d[4]! - im.d[5]!)).toBeLessThan(1 / 255)
  })

  it('overrides accept the pbr block and reject bad values', () => {
    const base = { format: 'sro-texpipe-overrides', version: 1 }
    expect(validateOverrides({ ...base, sets: { 'prim/mtrl/item/china/weapon/sword1_2_3.ddj': { pbr: { delight: 0, detail: 0.5, invertHeight: true, maskAllowed: ['metal', 'wood'], maskRelabel: { 3: 'wood', 7: 'fill' } } } } })).toEqual([])
    const bad = validateOverrides({ ...base, sets: { 'tile2d:x': { pbr: { delight: 2, maskRelabel: { 99: 'gold', 1: 'plastic' }, foo: 1 } } } })
    expect(bad.length).toBe(4)
  })

  it('class masks mark gutters MASK_NONE before dilation and a class after', () => {
    const w = 64, h = 32
    const islands = rasterIslands(Float64Array.from([0.1, 0.1, 0.4, 0.1, 0.4, 0.9]), w, h)
    const im = tileable(w, h, 2, [false, false])
    const r = run({ albedo: im, meta: meta({ key: 'prim/mtrl/item/china/man_item/clothes_01_ba.ddj', group: 'equipment', class: 'cloth', wrap: [false, false], sourceSize: [16, 8] }), islands })
    expect(r.classMask).not.toBeNull()
    expect(r.classMask![w * h - 1]).not.toBe(MASK_NONE)
    const owner = nearestOwner(islands.ids, w, h)
    const filled = fillFrom({ w, h, c: 1, d: Float32Array.from(islands.ids) }, owner)
    expect(filled.d.every(v => v === 0)).toBe(true)
  })
})

// ---- the B0 review tuning --------------------------------------------------------------------------------------------------

describe('B0 tuning', () => {
  const meanY = (im: Img) => {
    const L = luminance(im)
    return L.d.reduce((a, b) => a + b, 0) / L.d.length
  }

  it('de-light keeps the mean luminance (it used to darken every set) and still flattens the gradient', () => {
    const w = 64, h = 64
    const src = tileable(w, h, 9, [false, false])
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) src.d[(y * w + x) * 4 + k] *= 0.3 + 0.7 * (x / w)
    for (const k of [0.3, 0.6, 0.8]) {
      const out = delight(src, k, NO_WRAP, null)
      expect(Math.abs(meanY(out) / meanY(src) - 1)).toBeLessThan(0.01)
    }
    // Per region: each island keeps its own mean.
    const two = {
      w, h, ids: Int32Array.from({ length: w * h }, (_, p) => (p % w < 32 ? 0 : 1)), count: 2,
      boxes: [[0, 0, 32, h], [32, 0, w, h]] as [number, number, number, number][],
    }
    const out = delight(src, 0.7, NO_WRAP, two)
    const half = (im: Img, left: boolean) => {
      let s = 0, n = 0
      const L = luminance(im)
      for (let p = 0; p < w * h; p++) {
        if ((p % w < 32) !== left) continue
        s += L.d[p]!
        n++
      }
      return s / n
    }
    expect(Math.abs(half(out, true) / half(src, true) - 1)).toBeLessThan(0.01)
    expect(Math.abs(half(out, false) / half(src, false) - 1)).toBeLessThan(0.01)
  })

  it('wall and bark AO/relief is lowered at the profile; opaque tre_ trunks are bark, building pillars are not', () => {
    expect(PROFILE_PARAMS.wall).toMatchObject({ ao: 0.4, normal: 1.9 })
    expect(PROFILE_PARAMS.bark).toMatchObject({ ao: 0.5, normal: 2.25 })
    expect(profileOf('prim/mtrl/nature/common/tree/tre_bank_pilla.ddj', 'wood')).toBe('bark')
    expect(profileOf('prim/mtrl/nature/common/tree/tre_frie_body.ddj', 'wood')).toBe('bark')
    expect(profileOf('prim/mtrl/nature/common/tree/tre_pine08_03.ddj', 'foliage')).toBe('leaves')
    expect(profileOf('prim/mtrl/bldg/china/jangan03/cj_pal_pillar.ddj', 'wood')).toBe('wood')
    expect(profileOf('prim/mtrl/bldg/china/dunhuang/ferry/naru_pilla01.ddj', 'default')).toBe('default')
    // AO 0.4 (was 1) is 0.4 × the cavity darkening where the floor does not clip it.
    const w = 48, h = 48
    const src = tileable(w, h, 4)
    const m = meta({ key: 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj', sourceSize: [12, 12] })
    const full = run({ albedo: src, meta: m, override: { aoScale: 2.5 } }).planes.ao
    const half = run({ albedo: src, meta: m }).planes.ao
    let a = 0, b = 0
    for (let p = 0; p < w * h; p++) {
      if (!(full[p]! > 0.3)) continue
      a += 1 - full[p]!
      b += 1 - half[p]!
    }
    expect(b / a).toBeCloseTo(0.4, 1)
  })

  it('surface orientation: tiles and floors face up, roofs slope, walls, trunks and actors are vertical', () => {
    expect(surfaceUp('tile2d:c_marble_jang_04', 'tile', 'stone')).toBe(1)
    expect(surfaceUp('prim/mtrl/bldg/china/greenfield/cj_stoneb_floor.ddj', 'world', 'stone')).toBe(1)
    expect(surfaceUp('prim/mtrl/bldg/china/jangan03/cj_pal_roof.ddj', 'world', 'roof_tile')).toBe(0.7)
    expect(surfaceUp('prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj', 'world', 'stone')).toBe(0)
    expect(surfaceUp('prim/mtrl/nature/common/tree/tre_bank_pilla.ddj', 'world', 'wood')).toBe(0)
    expect(surfaceUp('prim/mtrl/item/china/weapon/sword1_2_3.ddj', 'equipment', 'metal')).toBe(0)
    expect(wetExposure(1)).toBe(1)
    expect(wetExposure(0)).toBeGreaterThan(0.6)
    expect(wetExposure(0)).toBeLessThan(0.7)
    expect(puddleFlatness(1)).toBe(1)
    expect(puddleFlatness(0.7)).toBe(0)
  })

  it('wet preview: puddles only where the surface faces up; a vertical bark gets darkening and a modest sheen', () => {
    const w = 32, h = 32
    const albedo = img(w, h, 4, 0.35)
    const normal = img(w, h, 3)
    const n = noise(w, h, 11)
    // Strong relief: normals tilted up to ~50° (bark ridges).
    for (let p = 0; p < w * h; p++) {
      const a = n[p]! * Math.PI * 2, t = 0.9 * n[(p * 7) % (w * h)]!
      normal.d[p * 3] = Math.sin(t) * Math.cos(a)
      normal.d[p * 3 + 1] = Math.sin(t) * Math.sin(a)
      normal.d[p * 3 + 2] = Math.cos(t)
    }
    const flat = (v: number) => new Float32Array(w * h).fill(v)
    const low = { albedo, normal, ao: flat(1), rough: flat(0.75), metal: flat(0), height: flat(0) }
    const high = { ...low, height: flat(1) }
    const stone = classParams('stone'), wood = classParams('wood')
    // A floor: low spots fill (different from high spots); a wall: height does not matter, no water collects.
    const floorLow = shade(low, { wet: 1, cls: stone, up: 1 }), floorHigh = shade(high, { wet: 1, cls: stone, up: 1 })
    expect(maxDiff(floorLow.d, floorHigh.d)).toBeGreaterThan(0.05)
    const wallLow = shade(low, { wet: 1, cls: stone, up: 0 }), wallHigh = shade(high, { wet: 1, cls: stone, up: 0 })
    expect(maxDiff(wallLow.d, wallHigh.d)).toBe(0)
    // Bark in rain: darker on average than dry, and the sheen stays modest: hardly any texel turns much brighter than
    // it was dry (the B0 sheet had white blobs), and far fewer than on the same bark fully soaked without the fill.
    const dry = shade(low, { wet: 0, cls: wood, up: 0 }), wet = shade(low, { wet: 1, cls: wood, up: 0 })
    const soaked = shade(low, { wet: 1, cls: wood, up: 0, exposure: 1 })
    expect(meanY(wet)).toBeLessThan(meanY(dry))
    const blobs = (im: Img) => {
      let n = 0
      for (let p = 0; p < w * h; p++) if (im.d[p * 4 + 1]! > dry.d[p * 4 + 1]! + 0.12) n++
      return n / (w * h)
    }
    expect(blobs(wet)).toBeLessThan(0.02)
    expect(blobs(wet)).toBeLessThan(blobs(soaked))
  })

  it('mask review: the jade class and a UV paint limited to clusters (one cluster, two materials)', () => {
    expect(MASK_CLASSES.slice(0, 7)).toEqual(['cloth', 'leather', 'metal', 'gold', 'skin', 'hair', 'wood'])
    expect(MASK_CLASSES[7]).toBe('jade')
    const w = 64, h = 32
    const im = img(w, h, 4)
    const n = noise(w, h, 5)
    for (let p = 0; p < w * h; p++) {
      const left = p % w < 32
      const c = left ? [0.85, 0.84, 0.8] : [0.42, 0.26, 0.14]
      for (let k = 0; k < 3; k++) im.d[p * 4 + k] = c[k]! + 0.04 * (n[p]! - 0.5)
      im.d[p * 4 + 3] = 1
    }
    const base = { albedo: im, scale: 2, regions: null, spec: false, allowed: ['cloth', 'leather', 'gold', 'metal'] as const, olive: 'leather' as const }
    const m = materialMasks({ ...base, allowed: [...base.allowed] })
    const brown = m.clusters[8 * 32 + 28]!
    // Paint the brown cluster as wood in the top half only; the bottom half stays leather, the cloth is untouched.
    const painted = materialMasks({ ...base, allowed: [...base.allowed], paint: [{ uv: [0, 0, 1, 0.5], class: 'wood', clusters: [brown] }] })
    expect(MASK_CLASSES[painted.index[4 * w + 56]!]).toBe('wood')
    expect(MASK_CLASSES[painted.index[28 * w + 56]!]).toBe('leather')
    expect(MASK_CLASSES[painted.index[4 * w + 8]!]).toBe('cloth')
    // A relabel to jade: glossy and dielectric in the ORMH.
    const jade = run({ albedo: im, meta: meta({ key: 'prim/mtrl/item/china/weapon/sword1_2_3.ddj', group: 'equipment', class: 'metal', wrap: [false, false], sourceSize: [32, 16] }), override: { maskRelabel: { [String(brown)]: 'jade' }, detail: 0 } })
    const leather = run({ albedo: im, meta: meta({ key: 'prim/mtrl/item/china/weapon/sword1_2_3.ddj', group: 'equipment', class: 'metal', wrap: [false, false], sourceSize: [32, 16] }), override: { detail: 0 } })
    const p = 16 * w + 56
    expect(MASK_CLASSES[jade.classMask![p]!]).toBe('jade')
    expect(MASK_CLASSES[leather.classMask![p]!]).toBe('leather')
    expect(jade.planes.metal[p]).toBeLessThan(0.05)
    expect(leather.planes.rough[p]! - jade.planes.rough[p]!).toBeCloseTo(MASK_PARAMS.leather.rough - MASK_PARAMS.jade.rough, 1)
    const t = detailTile('jade', 128)
    expect(t.alb.reduce((a, b) => a + b, 0) / t.alb.length).toBeCloseTo(1, 4)
    // The overrides format takes the paint and names what is wrong with a bad one.
    const ob = { format: 'sro-texpipe-overrides', version: 1 }
    expect(validateOverrides({ ...ob, sets: { 'prim/mtrl/item/china/weapon/sword1_2_3.ddj': { pbr: { maskRelabel: { 0: 'jade' }, maskPaint: [{ uv: [0, 0.86, 0.18, 1], class: 'wood', clusters: [8], note: 'grip' }] } } } })).toEqual([])
    const bad = validateOverrides({ ...ob, sets: { 'tile2d:x': { pbr: { maskPaint: [{ uv: [0.5, 0, 0.2, 2], class: 'plastic', clusters: [99], extra: 1 }] } } } })
    expect(bad.join('\n')).toMatch(/maskPaint\[0\]\.uv/)
    expect(bad.join('\n')).toMatch(/maskPaint\[0\]\.class/)
    expect(bad.join('\n')).toMatch(/maskPaint\[0\]\.clusters/)
    expect(bad.join('\n')).toMatch(/maskPaint\[0\]\.extra/)
  })
})

describe('9B check', () => {
  it('height keeps a flat albedo flat: relief in proportion to its contrast below HEIGHT_MIN_RANGE', () => {
    const w = 96
    const base = tileable(w, w, 5)
    // The same pattern at full contrast and at 1/8 of it (a stained slab): the textured one is normalised exactly as
    // before (p2..p98 -> 0..1), the flat one keeps a proportionally smaller relief around 0.5.
    const faint = clone(base)
    for (let p = 0; p < w * w; p++) for (let k = 0; k < 3; k++) faint.d[p * 4 + k] = 0.55 + (base.d[p * 4 + k]! - 0.55) / 8
    const spread = (H: Img) => {
      const v = Array.from(H.d).sort((a, b) => a - b)
      return v[Math.floor(0.98 * v.length)]! - v[Math.floor(0.02 * v.length)]!
    }
    const full = heightMap({ albedo: base, scale: 1, wrap: [true, true], regions: null })
    const flat = heightMap({ albedo: faint, scale: 1, wrap: [true, true], regions: null })
    expect(spread(full)).toBeGreaterThan(0.95)
    expect(spread(flat)).toBeLessThan(0.6)
    expect(spread(flat)).toBeGreaterThan(0.02)
    const mean = flat.d.reduce((a, b) => a + b, 0) / flat.d.length
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.1)
    // Above the floor the formula is TEXPIPE's, bit for bit; below it the range is the floor, centred.
    const v = Float32Array.from([0, 0.25, 0.5, 0.75, 1].map(x => x * 0.2))
    const a = Float32Array.from(v), b = Float32Array.from(v)
    normaliseRange(a, null, 0, 1)
    normaliseRange(b, null, 0, 1, 0.1)
    expect(Array.from(b)).toEqual(Array.from(a))
    const c = Float32Array.from(v.map(x => x / 4))
    normaliseRange(c, null, 0, 1, HEIGHT_MIN_RANGE)
    expect(c[2]!).toBeCloseTo(0.5, 5)
    expect(c[4]! - c[0]!).toBeCloseTo(0.05 / HEIGHT_MIN_RANGE, 3)
    // A flat stained surface gets far less AO darkening than the same pattern at full contrast (before the floor both
    // were stretched to the same relief, so their AO matched).
    const aoLoss = (albedo: Img) => 1 - Array.from(run({ albedo, meta: meta({ sourceSize: [w, w] }) }).planes.ao).reduce((x, y) => x + y, 0) / (w * w)
    expect(aoLoss(faint)).toBeLessThan(0.5 * aoLoss(base))
  })
})

// ---- files and the pool -------------------------------------------------------------------------------------------------

describe('jobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'texpipe-pbr-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('writes a master folder, skips it when fresh, and the pool gives the in-process result', async () => {
    const { writeFileSync } = await import('node:fs')
    const input = join(dir, 'in.png')
    writeFileSync(input, encodePng(tileable(64, 64, 8), 8))
    const job = (name: string, workers: string): PbrJob => ({
      key: `tile2d:${name}`, meta: meta({ key: `tile2d:${name}`, group: 'tile', sourceSize: [16, 16] }), input, inputKind: 'test',
      outDir: join(dir, workers, name), hash: 'h1', previewEdge: 32,
    })
    const first = await runJob(job('c_marble_a', 'solo'))
    expect(first.skipped).toBe(false)
    expect(first.files!['normal.png']).toBeGreaterThan(0)
    expect(first.files!['lit.png']).toBeGreaterThan(0)
    expect((await runJob(job('c_marble_a', 'solo'))).skipped).toBe(true)
    const jobs = [job('c_marble_a', 'pool'), job('c_marble_b', 'pool')]
    const pooled = await runPool(jobs, 2)
    expect(pooled.map(r => r.error)).toEqual([undefined, undefined])
    const a = await readImage(join(dir, 'solo', 'c_marble_a', 'ormh.png'))
    const b = await readImage(join(dir, 'pool', 'c_marble_a', 'ormh.png'))
    expect(maxDiff(a.d, b.d)).toBe(0)
    const inProc = await runPool([{ ...job('c_marble_c', 'inproc'), input: join(dir, 'missing.png') }], 0)
    expect(inProc[0]!.error).toBeTruthy()
  })
})
