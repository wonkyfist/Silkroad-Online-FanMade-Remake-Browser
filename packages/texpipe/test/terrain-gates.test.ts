/**
 * TT-B: the painterly ground rule's gates (docs/TERRAIN_TEX.md §3.2, F11; docs/WAVE_PLAN8.md TT-B): the one pinned
 * grain metric on synthetic tiles, the colour lock, the in-game gate, the fallback steps, and the terrain sheet.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it } from 'vitest'
import {
  colourStats, COLOUR_EXEMPT, fineEnergy, formatGates, gaussianKernel, gaussianWrap, inGameGate, lumaOf, nextAoStep, nextGrainStep,
  terrainGates, terrainGatesOf, terrainSheet, SHEET_PANEL, TERRAIN_GATES,
} from '../src/review.ts'
import type { RawImage } from '../src/upscale/pad.ts'

const N = TERRAIN_GATES.size

/** A seeded grey-noise RGB tile (the gritty painted soil stand-in) around `base`, ±`amp`. */
function noiseTile(seed: number, base = 120, amp = 40, n: number = N): RawImage {
  let s = seed >>> 0
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const data = new Uint8Array(n * n * 3)
  for (let p = 0; p < n * n; p++) {
    const v = Math.round(base + (rand() * 2 - 1) * amp)
    data[p * 3] = v + 6
    data[p * 3 + 1] = v
    data[p * 3 + 2] = v - 10
  }
  return { data, width: n, height: n, channels: 3 }
}

/** A 3×3 box blur that wraps (what an over-smoothing upscale does to the grain). */
function boxBlur(img: RawImage): RawImage {
  const { width: w, height: h, channels: c } = img
  const out = new Uint8Array(img.data.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    let sum = 0
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += img.data[((((y + j) % h) + h) % h * w + (((x + i) % w) + w) % w) * c + k]!
    out[(y * w + x) * c + k] = Math.round(sum / 9)
  }
  return { ...img, data: out }
}

function shifted(img: RawImage, d: [number, number, number]): RawImage {
  const out = new Uint8Array(img.data.length)
  for (let p = 0; p < img.data.length; p++) out[p] = Math.min(255, Math.max(0, img.data[p]! + d[p % 3]!))
  return { ...img, data: out }
}

describe('the pinned grain metric (TERRAIN_TEX F11)', () => {
  it('σ 1.5: an 11-tap normalised symmetric kernel', () => {
    const k = gaussianKernel(TERRAIN_GATES.sigma)
    expect(k.length).toBe(11)
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
    for (let i = 0; i < 5; i++) expect(k[i]).toBeCloseTo(k[10 - i]!, 7)
    expect(k[5]).toBeCloseTo(0.2659, 3)
  })

  it('the blur wraps on both axes and keeps the mass', () => {
    const w = 16, h = 8
    const src = new Float32Array(w * h)
    src[0] = 1000
    const b = gaussianWrap(src, w, h, 1.5)
    expect(b.reduce((a, v) => a + v, 0)).toBeCloseTo(1000, 2)
    expect(b[w - 1]).toBeCloseTo(b[1]!, 4) // left neighbour across the U edge
    expect(b[(h - 1) * w]).toBeCloseTo(b[w]!, 4) // the row above across the V edge
  })

  it('Rec. 601 luma; a flat tile has no fine energy', () => {
    expect(lumaOf({ data: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]), width: 3, height: 1, channels: 3 })[1]).toBeCloseTo(149.685, 3)
    expect(fineEnergy({ data: new Uint8Array(32 * 32 * 3).fill(97), width: 32, height: 32, channels: 3 })).toBe(0)
  })

  it('pins the number: a period-8 stripe tile (0/255) has fine energy 73.084 (numpy cross-check)', () => {
    const n = 64
    const data = new Uint8Array(n * n * 3)
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data.fill(x % 8 < 4 ? 255 : 0, (y * n + x) * 3, (y * n + x) * 3 + 3)
    expect(fineEnergy({ data, width: n, height: n, channels: 3 })).toBeCloseTo(73.084, 2)
  })

  it('grain retention on a synthetic noise tile: itself 100 %; a 3×3 box blur loses most of it (fails the 60 % gate)', () => {
    const retail = noiseTile(7)
    expect(terrainGatesOf('tile2d:x', retail, retail).grain).toBe(1)
    const soft = terrainGatesOf('tile2d:x', retail, boxBlur(retail))
    expect(soft.grain).toBeLessThan(TERRAIN_GATES.grainMin)
    expect(soft.grainPass).toBe(false)
    expect(soft.pass).toBe(false)
    expect(soft.colourPass).toBe(true)
  })
})

describe('the colour lock (±3 levels luma, ±4 per channel)', () => {
  const retail = noiseTile(11)
  it('passes a +3 shift, fails +4', () => {
    expect(terrainGatesOf('tile2d:x', retail, shifted(retail, [3, 3, 3])).colourPass).toBe(true)
    const g = terrainGatesOf('tile2d:x', retail, shifted(retail, [4, 4, 4]))
    expect(g.dLum).toBeCloseTo(4, 1)
    expect(g.colourPass).toBe(false)
  })
  it('fails a +5 blue cast that keeps the luma within 3', () => {
    const g = terrainGatesOf('tile2d:x', retail, shifted(retail, [0, 0, 5]))
    expect(Math.abs(g.dLum)).toBeLessThan(1)
    expect(g.dRgb[2]).toBeCloseTo(5, 1)
    expect(g.colourPass).toBe(false)
  })
  it("exempts P-LOOK's golden sand (and the coast's wet sand)", () => {
    expect(Object.keys(COLOUR_EXEMPT).sort()).toEqual(['tile2d:asiaminor_sand_01', 'tile2d:asiaminor_sand_02', 'tile2d:oaho_dust_earth01'])
    const g = terrainGatesOf('tile2d:asiaminor_sand_01', retail, shifted(retail, [-7, -16, -28]))
    expect(g.colourPass).toBe(true)
    expect(g.colourExempt).toMatch(/P-LOOK/)
  })
  it('colour stats are channel means', () => {
    const c = colourStats({ data: new Uint8Array([10, 20, 30, 30, 40, 50]), width: 2, height: 1, channels: 3 })
    expect(c.rgb).toEqual([20, 30, 40])
    expect(c.lum).toBeCloseTo(0.299 * 20 + 0.587 * 30 + 0.114 * 40, 6)
  })
})

describe('the in-game gate (at most 3 levels darker at the spot, Medium noon)', () => {
  it('−3 passes, −3.01 fails, brighter passes', () => {
    expect(inGameGate('dirt', 70, 67).pass).toBe(true)
    expect(inGameGate('dirt', 70, 66.99).pass).toBe(false)
    expect(inGameGate('dirt', 70, 75).pass).toBe(true)
    expect(inGameGate('dirt', 70, 64).delta).toBe(-6)
  })
  it('a failing in-game gate fails the tile even when grain and colour pass', () => {
    const t = noiseTile(3)
    const g = terrainGatesOf('tile2d:x', t, t, inGameGate('moss', 77, 69))
    expect(g.grainPass && g.colourPass).toBe(true)
    expect(g.pass).toBe(false)
    expect(formatGates(g)).toMatch(/in game −8\.0 FAIL/)
  })
})

describe('the fallback steps (TERRAIN_TEX §3.2)', () => {
  it('grain: SDXL → GAN 0.5; 0.8 → 0.5 → 0.3 → the retail route → nothing left', () => {
    expect(nextGrainStep({ detail: 'sdxl', aiMix: 0.8 })).toEqual({ detail: 'gan', aiMix: 0.5 })
    expect(nextGrainStep({ detail: 'gan', aiMix: 0.8 })).toEqual({ detail: 'gan', aiMix: 0.5 })
    expect(nextGrainStep({ detail: 'gan', aiMix: 0.5 })).toEqual({ detail: 'gan', aiMix: 0.3 })
    expect(nextGrainStep({ detail: 'gan', aiMix: 0.3 })).toEqual({ detail: 'retail', aiMix: 0 })
    expect(nextGrainStep({ detail: 'retail', aiMix: 0 })).toBeNull()
  })
  it('in game: aoScale 0.25 → 0.15 → 0.05 → 0 → nothing left', () => {
    expect(nextAoStep(0.25)).toBe(0.15)
    expect(nextAoStep(0.15)).toBe(0.05)
    expect(nextAoStep(0.05)).toBe(0)
    expect(nextAoStep(0)).toBeNull()
  })
})

describe('files: the gates and the terrain sheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'texpipe-tgates-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const png = async (name: string, img: RawImage) => {
    const f = join(dir, name)
    writeFileSync(f, await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: 3 } }).png().toBuffer())
    return f
  }

  it('terrainGates reads the files (a 1024 retail is resized to 512)', async () => {
    const retail = await png('retail.png', noiseTile(5))
    const same = await png('tier.png', noiseTile(5))
    const g = await terrainGates('tile2d:x', retail, same)
    expect(g.grain).toBe(1)
    expect(g.pass).toBe(true)
    const big = await png('big.png', noiseTile(5, 120, 40, 1024))
    const g2 = await terrainGates('tile2d:x', big, same)
    expect(g2.grain).toBeGreaterThan(0)
  })

  it('the sheet: seven panels (retail, upscale, albedo, 512, 1024, two 3×3 repeats) with the gates in the title', async () => {
    const retail = await png('r.png', noiseTile(9))
    const tier = await png('t.png', boxBlur(noiseTile(9)))
    const up = await png('u.png', noiseTile(9, 120, 40, 1024))
    const buf = await terrainSheet({ key: 'tile2d:x', retail, up, albedo: up, tier512: tier, tier1024: up, gates: terrainGatesOf('tile2d:x', noiseTile(9), boxBlur(noiseTile(9))), caption: 'test' })
    const meta = await sharp(buf).metadata()
    expect(meta.width).toBe(8 + 7 * (SHEET_PANEL + 8))
    expect(meta.height).toBe(46 + 20 + SHEET_PANEL + 8)
  })
})
