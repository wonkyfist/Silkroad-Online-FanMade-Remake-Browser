/**
 * TP-U upscale runner (docs/TEXPIPE.md §3.4, §10 TP-U; docs/WAVE_PLAN3.md §7.1): per-axis wrap padding, alpha bleed,
 * cutout coverage, the AI/Lanczos mix, the cache, and a real 2-texture Real-ESRGAN run (skipped without the exe or
 * work/out). Synthetic tests use stub upscalers, so they run anywhere.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateOverrides } from '../src/format.ts'
import { buildInventory, defaultOutDir, type InventoryEntry } from '../src/inventory.ts'
import {
  bleedAlpha, coverage, coverageMips, cutoffByte, downsampleAlpha, rethreshold,
} from '../src/upscale/alpha.ts'
import { sha1, UpscaleCache } from '../src/upscale/cache.ts'
import { mixImages, planFor, toneMatch, upscaleNearest } from '../src/upscale/mix.ts'
import {
  cropUpscaled, padImage, padPlan, rawImage, seamRatio, takeChannels, type PadPlan, type RawImage,
} from '../src/upscale/pad.ts'
import {
  findRealesrgan, loadSource, realesrganBackend, upscaleJobs, type UpscaleBackend, type UpscaleJob,
} from '../src/upscale/runner.ts'

// ---- synthetic images and stub upscalers ------------------------------------------------------------------------------

/** A w×h image from f(x, y, channel) → 0..255. */
function synth(w: number, h: number, c: number, f: (x: number, y: number, k: number) => number): RawImage {
  const img = rawImage(w, h, c)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    img.data[(y * w + x) * c + k] = Math.max(0, Math.min(255, Math.round(f(x, y, k))))
  }
  return img
}

/** Deterministic noise in 0..1. */
function hash01(x: number, y: number, k = 0): number {
  let n = (x * 374761393 + y * 668265263 + k * 2147483647) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

/**
 * A smooth tileable texture: sums of sines with whole periods over (w, h), plus a little noise wrapped per axis.
 * `tileV = false` adds a strong ramp in V so the top and bottom rows differ (a U-only texture like the wall).
 */
function tileable(w: number, h: number, tileV = true): RawImage {
  return synth(w, h, 3, (x, y, k) => {
    const u = (2 * Math.PI * x) / w
    const v = (2 * Math.PI * y) / h
    let s = 128 + 50 * Math.sin(u * 2 + k) + 30 * Math.cos(v * 3 + 2 * k) + 20 * Math.sin(u * 5 + v * (tileV ? 2 : 0))
    if (!tileV) s += (y / (h - 1)) * 120 - 60
    return s + 40 * (hash01(x, y, k) - 0.5)
  })
}

/**
 * Bilinear ×4 with clamped edges: like a real model, it only sees the pixels it is given, so an unpadded tileable
 * input comes out with a seam, and the pad decides what the edges blend with.
 */
function bilinear(img: RawImage, s = 4): RawImage {
  const { width: w, height: h, channels: c } = img
  const out = rawImage(w * s, h * s, c)
  for (let Y = 0; Y < h * s; Y++) {
    const fy = Math.min(h - 1, Math.max(0, (Y + 0.5) / s - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(h - 1, y0 + 1)
    const ty = fy - y0
    for (let X = 0; X < w * s; X++) {
      const fx = Math.min(w - 1, Math.max(0, (X + 0.5) / s - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(w - 1, x0 + 1)
      const tx = fx - x0
      for (let k = 0; k < c; k++) {
        const a = img.data[(y0 * w + x0) * c + k]! * (1 - tx) + img.data[(y0 * w + x1) * c + k]! * tx
        const b = img.data[(y1 * w + x0) * c + k]! * (1 - tx) + img.data[(y1 * w + x1) * c + k]! * tx
        out.data[(Y * w * s + X) * c + k] = Math.round(a * (1 - ty) + b * ty)
      }
    }
  }
  return out
}

/** pad → stub upscale → crop, as the runner does. */
function viaPad(img: RawImage, plan: PadPlan, up: (i: RawImage) => RawImage): RawImage {
  return cropUpscaled(up(padImage(img, plan)), plan, 4, img.width, img.height)
}

function stubBackend(fn: (i: RawImage) => RawImage, calls: string[] = []): UpscaleBackend {
  return {
    name: 'stub',
    identity: 'stub-1',
    async run(model, images) {
      calls.push(`${model}:${images.length}`)
      return images.map(fn)
    },
  }
}

const tmpDirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'tp-u-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

// ---- padding ------------------------------------------------------------------------------------------------------------

describe('per-axis wrap padding', () => {
  it('P = min(32, w/4, h/4) on wrapping textures; atlases are not padded', () => {
    expect(padPlan(512, 512, [true, true])).toEqual({ pad: 32, u: 'repeat', v: 'repeat' })
    expect(padPlan(256, 512, [true, false])).toEqual({ pad: 32, u: 'repeat', v: 'copy' })
    expect(padPlan(64, 256, [true, false])).toEqual({ pad: 16, u: 'repeat', v: 'copy' })
    expect(padPlan(256, 64, [false, true])).toEqual({ pad: 16, u: 'copy', v: 'repeat' })
    expect(padPlan(512, 256, [false, false])).toEqual({ pad: 0, u: 'copy', v: 'copy' })
  })

  it('a U-only texture gets repeat on the left and right and copy on the top and bottom', () => {
    const w = 16
    const h = 8
    const img = synth(w, h, 1, (x, y) => y * 16 + x)
    const plan = padPlan(w, h, [true, false])
    expect(plan).toEqual({ pad: 2, u: 'repeat', v: 'copy' })
    const p = padImage(img, plan)
    const at = (x: number, y: number) => p.data[y * p.width + x]!
    const src = (x: number, y: number) => img.data[y * w + x]!
    expect([p.width, p.height]).toEqual([w + 4, h + 4])
    for (let y = 0; y < h; y++) {
      // left pad = the right edge columns, right pad = the left edge columns (repeat)
      expect([at(0, y + 2), at(1, y + 2)]).toEqual([src(w - 2, y), src(w - 1, y)])
      expect([at(w + 2, y + 2), at(w + 3, y + 2)]).toEqual([src(0, y), src(1, y)])
    }
    for (let x = 0; x < w; x++) {
      // top pad = the first row, bottom pad = the last row (copy), never the opposite side
      expect([at(x + 2, 0), at(x + 2, 1)]).toEqual([src(x, 0), src(x, 0)])
      expect([at(x + 2, h + 2), at(x + 2, h + 3)]).toEqual([src(x, h - 1), src(x, h - 1)])
    }
    // corners combine both rules: top-left pad = row 0, wrapped from the right edge
    expect(at(0, 0)).toBe(src(w - 2, 0))
  })

  it('pad → nearest ×4 → crop is exactly nearest ×4 of the source (the crop is exact)', () => {
    const img = synth(24, 12, 3, (x, y, k) => hash01(x, y, k) * 255)
    for (const wrap of [[true, true], [true, false], [false, true], [false, false]] as Array<[boolean, boolean]>) {
      const plan = padPlan(24, 12, wrap)
      const out = viaPad(img, plan, i => upscaleNearest(i, 4))
      expect([out.width, out.height]).toEqual([96, 48])
      expect(Buffer.from(out.data).equals(Buffer.from(upscaleNearest(img, 4).data))).toBe(true)
    }
  })

  it('cropUpscaled refuses an upscale that changed the size (a UV shift)', () => {
    const plan = padPlan(16, 16, [true, true])
    expect(plan.pad).toBe(4)
    expect(() => cropUpscaled(rawImage(64, 64, 3), plan, 4, 16, 16)).toThrow(/expected 96x96/)
  })

  it('a tileable texture stays seamless on both axes (seam ratio ≤ 1.2); unpadded it does not', () => {
    const img = tileable(256, 128)
    expect(seamRatio(img, 'u')).toBeLessThan(1.05)
    expect(seamRatio(img, 'v')).toBeLessThan(1.05)
    const padded = viaPad(img, padPlan(256, 128, [true, true]), i => bilinear(i))
    const unpadded = viaPad(img, padPlan(256, 128, [false, false]), i => bilinear(i))
    // Phase-matched at the upscale factor (seamRatio's `period`): the wrap pair against pairs on pixel boundaries.
    expect(seamRatio(padded, 'u', 4)).toBeLessThanOrEqual(1.2)
    expect(seamRatio(padded, 'v', 4)).toBeLessThanOrEqual(1.2)
    expect(seamRatio(unpadded, 'u', 4)).toBeGreaterThan(2)
    expect(seamRatio(unpadded, 'v', 4)).toBeGreaterThan(2)
  })

  it('seam ratio: 1 on a periodic ramp, large on a cut, and phase-matched pairs only with a period', () => {
    const triangle = synth(64, 4, 3, x => 32 + 3 * Math.abs(x - 32))
    expect(seamRatio(triangle, 'u')).toBeCloseTo(1, 6)
    const cut = synth(64, 4, 3, x => x * 3)
    expect(seamRatio(cut, 'u')).toBeGreaterThan(50)
    // Nearest ×4 of periodic noise: flat inside each source pixel, so the wrap pair (a pixel boundary) looks like a
    // seam against every pair, and like any other boundary against the phase-matched pairs.
    const noise = upscaleNearest(synth(32, 32, 3, (x, y, k) => hash01(x, y, k) * 255), 4)
    expect(seamRatio(noise, 'u', 1)).toBeGreaterThan(3)
    expect(seamRatio(noise, 'u', 4)).toBeGreaterThan(0.7)
    expect(seamRatio(noise, 'u', 4)).toBeLessThan(1.3)
    expect(() => seamRatio(noise, 'u', 5)).toThrow(/multiple/)
  })

  it('per axis: U wraps seamlessly while the clamped V edges keep their own colours (all-sides repeat bleeds them)', () => {
    const w = 256
    const h = 128
    const img = tileable(w, h, false)
    // The source does not tile in V: its top and bottom rows differ by ~120 levels.
    expect(seamRatio(img, 'v')).toBeGreaterThan(5)
    const perAxis = viaPad(img, padPlan(w, h, [true, false]), i => bilinear(i))
    const allRepeat = viaPad(img, { pad: 32, u: 'repeat', v: 'repeat' }, i => bilinear(i))
    const reference = bilinear(img) // what the clamped edges look like with no padding at all
    expect(seamRatio(perAxis, 'u', 4)).toBeLessThanOrEqual(1.2)
    // Mean |difference| of the top and bottom output rows against the clamped reference.
    const edgeDiff = (a: RawImage) => {
      let d = 0
      for (const y of [0, a.height - 1]) for (let i = y * a.width * 3; i < (y + 1) * a.width * 3; i++) d += Math.abs(a.data[i]! - reference.data[i]!)
      return d / (2 * a.width * 3)
    }
    expect(edgeDiff(perAxis)).toBeLessThan(0.5)
    expect(edgeDiff(allRepeat)).toBeGreaterThan(10)
    // The clamped axis's own ratio is kept (it was 5.1 → 11 on the wall with all-sides repeat).
    const src = seamRatio(bilinear(img), 'v')
    expect(seamRatio(perAxis, 'v') / src).toBeGreaterThan(0.95)
    expect(seamRatio(perAxis, 'v') / src).toBeLessThan(1.05)
    expect(seamRatio(allRepeat, 'v')).toBeLessThan(src * 0.5)
  })
})

// ---- alpha ------------------------------------------------------------------------------------------------------------

/** A leaf-like cutout: opaque green blobs with a bright red matte colour in the transparent texels. */
function leaf(w: number, h: number): RawImage {
  return synth(w, h, 4, (x, y, k) => {
    const d = Math.hypot(x - w * 0.4, y - h * 0.5) / (w * 0.3) + 0.3 * Math.sin(x * 0.5) * Math.cos(y * 0.4)
    const opaque = d < 1
    if (k === 3) return opaque ? 255 : 0
    if (!opaque) return [255, 0, 0][k]!
    return [40 + 30 * hash01(x, y), 120 + 60 * hash01(y, x), 30][k]!
  })
}

describe('alpha', () => {
  it('bleed leaves opaque texels and alpha unchanged and replaces the matte colour', () => {
    const img = leaf(64, 64)
    const out = bleedAlpha(img, { threshold: 128 })
    let transparentRed = 0
    for (let p = 0; p < 64 * 64; p++) {
      const a = img.data[p * 4 + 3]!
      expect(out.data[p * 4 + 3]).toBe(a)
      if (a >= 128) for (let k = 0; k < 3; k++) expect(out.data[p * 4 + k]).toBe(img.data[p * 4 + k])
      else if (out.data[p * 4]! > 200 && out.data[p * 4 + 1]! < 50) transparentRed++
    }
    expect(transparentRed).toBe(0)
    // Next to the edge the bled colour is the leaf's green, not red.
    const p = 32 * 64 + Math.round(64 * 0.4 + 64 * 0.3 * 1.05)
    expect(out.data[p * 4 + 1]!).toBeGreaterThan(out.data[p * 4]!)
  })

  it('bleed is a no-op on fully opaque and fully transparent images', () => {
    const opaque = synth(8, 8, 4, (x, y, k) => (k === 3 ? 255 : x * 20 + k))
    expect(Buffer.from(bleedAlpha(opaque).data).equals(Buffer.from(opaque.data))).toBe(true)
    const clear = synth(8, 8, 4, (x, _y, k) => (k === 3 ? 0 : x * 20 + k))
    expect(Buffer.from(bleedAlpha(clear).data).equals(Buffer.from(clear.data))).toBe(true)
  })

  it('re-threshold keeps the cutoff and steepens the ramp to ~2 px', () => {
    const a = Uint8Array.from([0, 64, 96, 128, 160, 192, 255])
    rethreshold(a, 4)
    expect(Array.from(a)).toEqual([0, 0, 65, 129, 193, 255, 255])
    expect(cutoffByte()).toBe(128)
  })

  it('coverage-preserving mips keep the cutoff coverage within 2% at every mip down to 8×8', () => {
    // A leaf card: 140 small leaves (2–8 px) with the ~2 px edge ramp the re-threshold leaves. Plain box mips lose
    // coverage as the leaves shrink below a texel.
    const w = 256
    const leaves = Array.from({ length: 140 }, (_, i) => [hash01(i, 1) * w, hash01(i, 2) * w, 2 + hash01(i, 3) * 6] as const)
    const img = synth(w, w, 1, (x, y) => {
      let d = -99
      for (const [lx, ly, r] of leaves) d = Math.max(d, r - Math.hypot(x - lx, y - ly))
      return (0.5 + d / 2) * 255
    })
    const top = coverage(img.data)
    expect(top).toBeGreaterThan(0.1)
    const mips = coverageMips(img.data, w, w)
    expect(mips.length).toBe(9)
    let plain = { data: img.data, width: w, height: w }
    let plainDrift = 0
    for (const m of mips.slice(1)) {
      plain = downsampleAlpha(plain.data, plain.width, plain.height)
      if (m.width >= 8) {
        expect(Math.abs(coverage(m.data) - top), `mip ${m.width}`).toBeLessThanOrEqual(0.02)
        plainDrift = Math.max(plainDrift, Math.abs(coverage(plain.data) - top))
      } else {
        // Below 8×8 one texel is more than 2%: within one texel.
        expect(Math.abs(coverage(m.data) - top)).toBeLessThanOrEqual(1 / (m.width * m.height) + 1e-9)
      }
    }
    expect(plainDrift).toBeGreaterThan(0.05)
  })
})

// ---- model choice and mix ---------------------------------------------------------------------------------------------

describe('model choice and the AI/Lanczos mix', () => {
  it('x4plus for natural classes, anime only for hair, overrides and the retail status win', () => {
    expect(planFor('tile2d:c_grass_fld_03', 'ground_grass')).toMatchObject({ model: 'realesrgan-x4plus', aiMix: 0.8 })
    expect(planFor('tile2d:c_marble_jang_09', 'stone')).toMatchObject({ model: 'realesrgan-x4plus', aiMix: 0.6 })
    expect(planFor('prim/mtrl/item/china/weapon/sword1_2_3.ddj', 'metal')).toMatchObject({ model: 'realesrgan-x4plus', aiMix: 0.7 })
    expect(planFor('prim/mtrl/char/china/man/chinaman_adventurer_body.ddj', 'skin')).toMatchObject({ model: 'realesrgan-x4plus', aiMix: 0.5 })
    expect(planFor('prim/mtrl/char/china/man/chinaman_adventurer_hair.ddj', 'default')).toMatchObject({ model: 'realesrgan-x4plus-anime', reason: 'hair' })
    expect(planFor('prim/mtrl/nature/common/tree/chair01.ddj', 'wood').model).toBe('realesrgan-x4plus')
    expect(planFor('tile2d:x', 'stone', { model: 'realesrgan-x4plus-anime', aiMix: 0.3 })).toMatchObject({ model: 'realesrgan-x4plus-anime', aiMix: 0.3 })
    expect(planFor('tile2d:x', 'stone', { aiMix: 7 }).aiMix).toBe(1)
    expect(planFor('tile2d:x', 'stone', undefined, 'retail')).toMatchObject({ model: 'lanczos', aiMix: 0 })
  })

  it('mix = t × AI + (1 − t) × Lanczos', () => {
    const a = rawImage(2, 1, 3, Uint8Array.from([200, 100, 0, 255, 255, 255]))
    const l = rawImage(2, 1, 3, Uint8Array.from([100, 100, 100, 0, 0, 0]))
    expect(mixImages(a, l, 1)).toBe(a)
    expect(mixImages(a, l, 0)).toBe(l)
    expect(Array.from(mixImages(a, l, 0.6).data)).toEqual([160, 100, 40, 153, 153, 153])
  })

  it('tone match: the AI keeps its fine detail but takes the reference tone (B0: x4plus darkened grass and bark)', () => {
    const w = 64, h = 32
    // The reference: a smooth ramp; the "AI": the same with a fine checker added and darker overall (−20 % in sRGB,
    // about −40 % in linear luminance, like x4plus on the field grass).
    const ref = synth(w, h, 3, (x, _y, k) => 90 + 80 * (x / w) + 10 * k)
    const ai = synth(w, h, 3, (x, y, k) => (0.8 * (90 + 80 * (x / w) + 10 * k)) * (1 + 0.3 * (((x + y) % 2) * 2 - 1)))
    const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4
    const meanY = (im: RawImage) => {
      let s = 0
      for (let p = 0; p < w * h; p++) s += 0.2126 * lin(im.data[p * 3]!) + 0.7152 * lin(im.data[p * 3 + 1]!) + 0.0722 * lin(im.data[p * 3 + 2]!)
      return s / (w * h)
    }
    const out = toneMatch(ai, ref, 8, [true, false])
    expect(meanY(ai) / meanY(ref)).toBeLessThan(0.75)
    expect(Math.abs(meanY(out) / meanY(ref) - 1)).toBeLessThan(0.03)
    // The checker survives: neighbouring texels still differ as much, relative to their level, as in the AI output.
    const p = 16 * w + 32
    const rel = (im: RawImage) => Math.abs(im.data[p * 3 + 1]! - im.data[(p + 1) * 3 + 1]!) / (im.data[p * 3 + 1]! + im.data[(p + 1) * 3 + 1]!)
    expect(rel(out)).toBeGreaterThan(0.8 * rel(ai))
    // Hue is kept (one gain for R, G and B) and alpha is copied.
    const a4 = rawImage(w, h, 4)
    for (let q = 0; q < w * h; q++) {
      for (let k = 0; k < 3; k++) a4.data[q * 4 + k] = ai.data[q * 3 + k]!
      a4.data[q * 4 + 3] = q % 256
    }
    const o4 = toneMatch(a4, ref, 8, [true, false])
    for (let q = 0; q < w * h; q += 97) expect(o4.data[q * 4 + 3]).toBe(q % 256)
    // A tone-correct AI output is left (nearly) alone.
    expect(Math.max(...Array.from(toneMatch(ref, ref, 8, [true, true]).data, (v, i) => Math.abs(v - ref.data[i]!)))).toBeLessThanOrEqual(1)
  })

  it('the overrides file takes an upscale block and rejects bad ones', () => {
    const base = { format: 'sro-texpipe-overrides', version: 1 }
    expect(validateOverrides({ ...base, sets: { 'tile2d:a': { upscale: { model: 'realesrgan-x4plus-anime', aiMix: 0.5 } } } })).toEqual([])
    const bad = validateOverrides({ ...base, sets: { 'tile2d:a': { upscale: { model: 'waifu2x', aiMix: 2, extra: 1 } } } })
    expect(bad.join('\n')).toMatch(/upscale\.model/)
    expect(bad.join('\n')).toMatch(/upscale\.aiMix/)
    expect(bad.join('\n')).toMatch(/upscale\.extra/)
  })
})

// ---- cache and the runner (stub upscaler) ---------------------------------------------------------------------------------

describe('runner with a stub upscaler', () => {
  it('sha1 parts are length-prefixed', () => {
    expect(sha1('ab', 'c')).not.toBe(sha1('a', 'bc'))
    expect(sha1('a', 1)).toBe(sha1('a', '1'))
    expect(sha1(Uint8Array.from([1]))).not.toBe(sha1('\u0001'))
  })

  it('upscales ×4 per axis, keeps alpha, reports seams and coverage, and caches by content', async () => {
    const dir = tmp()
    const cache = new UpscaleCache(join(dir, 'cache'))
    const tile = tileable(64, 64)
    const wall = tileable(64, 128, false)
    const leafImg = leaf(64, 64)
    const rgba = (img: RawImage) => synth(img.width, img.height, 4, (x, y, k) => (k === 3 ? 255 : img.data[(y * img.width + x) * 3 + k]!))
    const jobs: UpscaleJob[] = [
      { key: 'tile2d:t', class: 'ground_grass', alpha: 'none', wrap: [true, true], source: async () => rgba(tile) },
      { key: 'prim/w/wall.ddj', class: 'stone', alpha: 'none', wrap: [true, false], source: async () => rgba(wall) },
      { key: 'prim/n/leaf.ddj', class: 'foliage', alpha: 'cutout', wrap: [false, false], source: async () => leafImg },
      { key: 'prim/c/x_hair.ddj', class: 'default', alpha: 'blend', wrap: [false, false], source: async () => leafImg },
    ]
    const calls: string[] = []
    const files = new Map<string, string>()
    const first = await upscaleJobs(jobs, { backend: stubBackend(i => bilinear(i), calls), cache, onResult: (r, f) => { files.set(r.key, f) } })
    expect(calls.sort()).toEqual(['realesrgan-x4plus-anime:1', 'realesrgan-x4plus:3'])
    const [t, w, l, hair] = first.reports
    expect(t!.size).toEqual([256, 256])
    expect(w!.size).toEqual([256, 512])
    expect(w!.pad).toEqual({ pad: 16, u: 'repeat', v: 'copy' })
    // Wrap axes: seamless (the report's ratios are phase-matched at the upscale factor).
    for (const s of [t!.seams.u, t!.seams.v, w!.seams.u]) expect(s.out).toBeLessThanOrEqual(1.2)
    // The clamped V axis of the wall was not blended with its opposite edge (that would drive its ratio towards 1).
    expect(w!.seams.v.out).toBeGreaterThan(5)
    expect(l!.cutout!.mipScales.length).toBe(8)
    expect(Math.abs(l!.cutout!.coverage - coverage(takeChannels(leafImg, 1, 3).data))).toBeLessThan(0.02)
    expect(hair!.model).toBe('realesrgan-x4plus-anime')
    expect(first.stats.cached).toBe(0)
    expect(first.stats.ai.map(a => a.model).sort()).toEqual(['realesrgan-x4plus', 'realesrgan-x4plus-anime'])
    expect(existsSync(files.get('prim/n/leaf.ddj')!)).toBe(true)

    // Unchanged inputs: every result from the cache, no upscaler call.
    const again = await upscaleJobs(jobs, { backend: stubBackend(i => bilinear(i), calls), cache })
    expect(again.stats.cached).toBe(4)
    expect(calls.length).toBe(2)
    expect(again.reports.map(r => r.hash)).toEqual(first.reports.map(r => r.hash))

    // A mix change re-runs only that texture's mix and reuses the cached AI output.
    const changed = jobs.map(j => (j.key === 'tile2d:t' ? { ...j, override: { aiMix: 0.3 } } : j))
    const third = await upscaleJobs(changed, { backend: stubBackend(i => bilinear(i), calls), cache })
    expect(third.stats.cached).toBe(3)
    expect(calls.length).toBe(2)
    expect(third.reports[0]!.aiMix).toBe(0.3)
  })

  it('caps the long edge at 2048 and stays tileable', async () => {
    const cache = new UpscaleCache(join(tmp(), 'cache'))
    const big = synth(128, 64, 4, (x, y, k) => (k === 3 ? 255 : 128 + 60 * Math.sin((2 * Math.PI * x * 3) / 128 + k) + 40 * Math.cos((2 * Math.PI * y * 2) / 64)))
    const { reports } = await upscaleJobs([{ key: 'tile2d:big', class: 'stone', alpha: 'none', wrap: [true, true], source: async () => big }],
      { backend: stubBackend(i => bilinear(i)), cache, cap: 256 })
    expect(reports[0]!.size).toEqual([256, 128])
    expect(reports[0]!.seams.u.out).toBeLessThanOrEqual(1.2)
    expect(reports[0]!.seams.v.out).toBeLessThanOrEqual(1.2)
  })

  it('without an upscaler every texture takes the Lanczos path', async () => {
    const cache = new UpscaleCache(join(tmp(), 'cache'))
    const img = synth(16, 16, 4, (x, _y, k) => (k === 3 ? 255 : x * 15))
    const { reports, stats } = await upscaleJobs([{ key: 'tile2d:l', class: 'stone', alpha: 'none', wrap: [true, true], source: async () => img }], { backend: null, cache })
    expect(reports[0]).toMatchObject({ model: 'lanczos', aiMix: 0, reason: 'no upscaler', aiHash: null, size: [64, 64] })
    expect(stats.ai).toEqual([])
  })
})

// ---- a real run -------------------------------------------------------------------------------------------------------------

const EXE = findRealesrgan()
const OUT = defaultOutDir()
const HAS_REAL = EXE !== null && existsSync(join(OUT, 'world', 'jangan-fields', 'manifest.json'))

describe.skipIf(!HAS_REAL)('Real-ESRGAN on 2 real textures (local GPU)', () => {
  it('grass tile (U V) and city wall (U only): ms/Mpx, seams against the source, exact size', async () => {
    const inv = await buildInventory({ outDir: OUT, decodeAlpha: false })
    const pick = (suffix: string) => inv.entries.find(e => e.key.endsWith(suffix)) as InventoryEntry
    const entries = [pick('tile2d:c_grass_fld_03'), pick('/jangan_enter/cj_wall01.ddj')]
    expect(entries.every(Boolean)).toBe(true)
    expect(entries.map(e => e.wrap)).toEqual([[true, true], [true, false]])
    const dir = tmp()
    const cache = new UpscaleCache(join(dir, 'cache'))
    const jobs: UpscaleJob[] = entries.map(e => ({ key: e.key, class: e.class, alpha: e.alpha, wrap: e.wrap, source: () => loadSource(OUT, e) }))
    const { reports, stats } = await upscaleJobs(jobs, { backend: realesrganBackend(EXE!, { tmpDir: dir }), cache })
    const [grass, wall] = reports
    console.log(`TP-U real run: ${stats.ai.map(a => `${a.model} ${a.files} files ${a.sourceMpx} Mpx ${a.ms} ms = ${(a.msPerMpx / 1000).toFixed(1)} s/Mpx`).join('; ')}`)
    console.log(`  grass seams U ${grass!.seams.u.source}→${grass!.seams.u.out}, V ${grass!.seams.v.source}→${grass!.seams.v.out}`)
    console.log(`  wall  seams U ${wall!.seams.u.source}→${wall!.seams.u.out}, V (clamped) ${wall!.seams.v.source}→${wall!.seams.v.out}`)
    expect(stats.ai[0]!.msPerMpx).toBeGreaterThan(0)
    expect(grass!.size).toEqual([2048, 2048])
    expect(wall!.size).toEqual([1024, 2048])
    // Wrap axes: no worse than the source's own seam plus 20% (TEXPIPE §3.4 rule 2, real data).
    expect(grass!.seams.u.out).toBeLessThanOrEqual(Math.max(1.2, 1.2 * grass!.seams.u.source))
    expect(grass!.seams.v.out).toBeLessThanOrEqual(Math.max(1.2, 1.2 * grass!.seams.v.source))
    expect(wall!.seams.u.out).toBeLessThanOrEqual(Math.max(1.2, 1.2 * wall!.seams.u.source))
  })

  it('per-axis proof on the real wall: copy on V keeps its top and bottom edges, all-sides repeat does not', async () => {
    const inv = await buildInventory({ outDir: OUT, decodeAlpha: false })
    const wall = inv.entries.find(e => e.key.endsWith('/jangan_enter/cj_wall01.ddj'))!
    const src = takeChannels(await loadSource(OUT, wall), 3)
    const { width: w, height: h } = src
    const perAxis = padPlan(w, h, wall.wrap)
    expect(perAxis).toMatchObject({ u: 'repeat', v: 'copy' })
    const allSides: PadPlan = { pad: perAxis.pad, u: 'repeat', v: 'repeat' }
    const dir = tmp()
    const [a, b] = await realesrganBackend(EXE!, { tmpDir: dir }).run('realesrgan-x4plus', [padImage(src, perAxis), padImage(src, allSides)])
    const A = cropUpscaled(a!, perAxis, 4, w, h)
    const B = cropUpscaled(b!, allSides, 4, w, h)
    // Mean |difference| between the source's first and last rows and the 4×4 box average of the result's edge rows.
    const edgeError = (up: RawImage) => {
      let d = 0
      for (const [sy, oy] of [[0, 0], [h - 1, up.height - 4]] as const) {
        for (let x = 0; x < w; x++) {
          for (let k = 0; k < 3; k++) {
            let m = 0
            for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) m += up.data[((oy + yy) * up.width + 4 * x + xx) * 3 + k]!
            d += Math.abs(m / 16 - src.data[(sy * w + x) * 3 + k]!)
          }
        }
      }
      return d / (2 * w * 3)
    }
    const ea = edgeError(A)
    const eb = edgeError(B)
    console.log(`TP-U wall V edges: per-axis error ${ea.toFixed(1)} levels, V seam ${seamRatio(A, 'v').toFixed(2)}; all-sides repeat ${eb.toFixed(1)} levels, V seam ${seamRatio(B, 'v').toFixed(2)} (source ${seamRatio(src, 'v').toFixed(2)})`)
    expect(ea).toBeLessThan(eb)
    expect(ea).toBeLessThan(8)
    // U is padded the same way in both: identical U seams.
    expect(seamRatio(A, 'u')).toBeCloseTo(seamRatio(B, 'u'), 0)
  })
})
