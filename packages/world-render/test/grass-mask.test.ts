/**
 * W12-SB, seam S-GRASS (docs/WAVE_PLAN8.md §4.3; docs/WORLD_EDITOR.md §4.4, D22, D23, D55): the editor's grass /
 * flower mask in the region bake (grass/bake.ts) and GrassField's mask fetch, `invalidate(rect)` and `setMask`.
 *
 * - a mask that leaves everything as it is (R = 128, flower kind 0, or untouched texels) = today's bake byte for byte;
 * - R scales the density (×0 … ×2) after the feather and the slope fade, before the water cut; a painted flower kind
 *   sets the meadow to G × the density;
 * - a manifest-listed mask is fetched before the region bakes (the bake waits for it); no listed mask, no fetch;
 * - `invalidate(rect)` bakes the regions within the feather's reach again (heights by reference), and only those.
 * Low never makes a GrassField (the retail scatter): it never fetches or applies a mask (the Low guard tests).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import type { WorldRegion } from '../../convert/src/world/manifest.ts'
import { GRASS_MASK_ONE, GRASS_REGION_M, bakeRegionGrass, grassBakeSource, grassTileTable, meadowAt } from '../src/grass/bake.ts'
import { T, TILES, fieldRig, region, texel, type FieldRig } from './grass-fixture.ts'

const table = grassTileTable(TILES)
const rigs: FieldRig[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

const N = GRASS_REGION_M

/** A mask: `at(i, j)` → [R, G, B, A] per texel (i east, j north of the south edge). */
function mask(at: (i: number, j: number) => [number, number, number, number]): Uint8Array {
  const m = new Uint8Array(N * N * 4)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) m.set(at(i, j), (j * N + i) * 4)
  return m
}

/** A busy region: grass with a road band (the feather), a grassy-dirt patch, a slope and a pond block. */
function busy(id = 1) {
  return region({
    id,
    layers: [(cx, cz) => (cz >= 40 && cz < 44 ? [T.road, 15] : null), (cx, cz) => (cx > 70 && cz > 70 ? [T.dirt, 15] : null)],
    height: (gx, gz) => (gx < 20 ? 10 + gx * 0.9 : 10 + 18),
    water: (bx, bz) => (bx === 5 && bz === 0 ? 40 : null),
  })
}

describe('the mask in the bake (grass/bake.ts)', () => {
  it('a neutral mask (R 128, kind 0, any G), or untouched texels, = today\'s bake byte for byte', () => {
    const d = busy()
    const plain = bakeRegionGrass(grassBakeSource(d), table)
    expect(plain.some((v, k) => k % 4 === 0 && v > 0)).toBe(true)
    let seed = 3
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
    const ones = mask(() => [GRASS_MASK_ONE, rnd(), 0, 255])
    expect(Buffer.from(bakeRegionGrass(grassBakeSource(d, ones), table)).equals(Buffer.from(plain))).toBe(true)
    const untouched = mask(() => [rnd(), rnd(), rnd(), 0])
    expect(Buffer.from(bakeRegionGrass(grassBakeSource(d, untouched), table)).equals(Buffer.from(plain))).toBe(true)
    // a short mask (not 192²) is ignored, never read out of bounds
    expect(Buffer.from(bakeRegionGrass(grassBakeSource(d, new Uint8Array(16)), table)).equals(Buffer.from(plain))).toBe(true)
  })

  it('R scales the density (×0 … ×2) where touched; water still cuts it; the meadow follows', () => {
    const d = busy()
    const plain = bakeRegionGrass(grassBakeSource(d), table)
    // left third: none; the grassy-dirt corner: × 2; a strip over the pond block: × 2
    const m = mask((i, j) => (i < 64 ? [0, 0, 0, 255] : i > 150 && j > 150 ? [255, 0, 0, 255] : i >= 160 && j < 32 ? [255, 0, 0, 255] : [GRASS_MASK_ONE, 0, 0, 0]))
    const out = bakeRegionGrass(grassBakeSource(d, m), table)
    for (let j = 0; j < N; j += 9) {
      for (let i = 0; i < 64; i += 7) expect(texel(out, i, j)[0]).toBe(0)
    }
    // grassy dirt (0.45) doubled ≈ 0.9 (the feather and the slope aside: deep inside the patch)
    const [r0] = texel(plain, 175, 175), [r1] = texel(out, 175, 175)
    expect(r0).toBeGreaterThan(100)
    expect(r0).toBeLessThan(130)
    expect(r1).toBe(Math.min(255, Math.round((r0 / 255) * (255 / GRASS_MASK_ONE) * 255)))
    // the pond (water 40 m over ground 28 m) stays bare whatever the mask says
    expect(texel(out, 180, 10)[0]).toBe(0)
    // the untouched middle is the plain bake
    for (let j = 0; j < N; j += 11) for (let i = 100; i < 140; i += 5) expect(texel(out, i, j)).toEqual(texel(plain, i, j))
  })

  it('a painted flower kind sets the meadow to G × the density; kind 0 keeps the meadow noise', () => {
    const d = region({ id: 2 })
    const m = mask((i, j) => (i < 96 ? [GRASS_MASK_ONE, 255, 3, 255] : [GRASS_MASK_ONE, 0, 0, 255]))
    const out = bakeRegionGrass(grassBakeSource(d, m), table)
    const [r, g] = texel(out, 40, 40)
    expect(r).toBe(255)
    expect(g).toBe(255)
    const [, g2] = texel(out, 150, 40)
    expect(g2).toBe(Math.round(meadowAt(d.region.origin[0] + 150.5, d.region.origin[2] - 40.5, 1) * 255))
    const half = mask(() => [GRASS_MASK_ONE, 128, 1, 255])
    expect(texel(bakeRegionGrass(grassBakeSource(d, half), table), 40, 40)[1]).toBe(Math.round((128 / 255) * 255))
  })
})

/** Runs the field until nothing is pending (or `frames` run out). */
function settle(r: FieldRig, frames = 400) {
  const cam = { x: 96, y: 20, z: -96 }
  for (let f = 0; f < frames && r.field.stats.pending > 0; f++) r.field.update(cam)
}

const bakeOf = (r: FieldRig, id: number) => (r.field as unknown as { entries: Map<number, { grass: Uint8Array | null }> }).entries.get(id)!.grass

describe('GrassField: the mask fetch, setMask and invalidate (seam S-GRASS)', () => {
  it('fetches a manifest-listed mask before the region bakes; no listed mask, no fetch', async () => {
    const asked: string[] = []
    let release!: () => void
    const gate = new Promise<void>(res => (release = res))
    const m = mask(i => (i < 96 ? [0, 0, 0, 255] : [GRASS_MASK_ONE, 0, 0, 0]))
    const r = fieldRig({
      urgentSliceMs: 1e9, sliceMs: 1e9,
      mask: (_region, file) => {
        asked.push(file)
        return gate.then(() => ({ width: N, height: N, data: m }))
      },
    })
    rigs.push(r)
    const painted = region({ id: 1 })
    ;(painted.region as WorldRegion & { grassMask?: string }).grassMask = 'grass/168_97.png'
    const plain = region({ id: 2, ox: 192 })
    r.field.addRegion(painted)
    r.field.addRegion(plain)
    expect(asked).toEqual(['grass/168_97.png'])
    settle(r, 5)
    // the plain region baked; the painted one waits for its mask
    expect(bakeOf(r, 2)).not.toBeNull()
    expect(bakeOf(r, 1)).toBeNull()
    expect(r.field.stats.pending).toBe(1)
    release()
    await gate
    await new Promise(res => setTimeout(res, 0))
    settle(r)
    const got = bakeOf(r, 1)!
    expect(texel(got, 20, 100)[0]).toBe(0)
    expect(texel(got, 150, 100)[0]).toBe(255)
  })

  it('a failed or wrong-size mask bakes the region unpainted (one warning)', async () => {
    const warn = console.warn
    const warned: unknown[] = []
    console.warn = (...a: unknown[]) => void warned.push(a)
    try {
      const r = fieldRig({ mask: () => Promise.resolve({ width: 4, height: 4, data: new Uint8Array(64) }) })
      rigs.push(r)
      const d = region({ id: 1 })
      ;(d.region as WorldRegion & { grassMask?: string }).grassMask = 'grass/x.png'
      r.field.addRegion(d)
      await new Promise(res => setTimeout(res, 0))
      settle(r)
      expect(texel(bakeOf(r, 1)!, 20, 100)[0]).toBe(255)
      expect(warned.length).toBe(1)
    } finally {
      console.warn = warn
    }
  })

  it('setMask bakes the region again with the editor\'s live mask (and null takes it off)', () => {
    const r = fieldRig()
    rigs.push(r)
    r.field.addRegion(region({ id: 1 }))
    settle(r)
    expect(texel(bakeOf(r, 1)!, 20, 100)[0]).toBe(255)
    expect(r.field.setMask(1, mask(() => [0, 0, 0, 255]))).toBe(true)
    expect(r.field.stats.pending).toBe(1)
    // the old grass shows until the new bake is done
    expect(texel(bakeOf(r, 1)!, 20, 100)[0]).toBe(255)
    settle(r)
    expect(texel(bakeOf(r, 1)!, 20, 100)[0]).toBe(0)
    r.field.setMask(1, null)
    settle(r)
    expect(texel(bakeOf(r, 1)!, 20, 100)[0]).toBe(255)
    expect(r.field.setMask(99, null)).toBe(false)
  })

  it('invalidate(rect) re-bakes the regions within reach (a raised cliff loses its grass), and only those', () => {
    const r = fieldRig()
    rigs.push(r)
    const a = region({ id: 1, ox: 0, oz: 0 })
    const far = region({ id: 2, ox: 192 * 3, oz: 0 })
    r.field.addRegion(a)
    r.field.addRegion(far)
    settle(r)
    const fills = r.field.stats.fills
    expect(texel(bakeOf(r, 1)!, 100, 100)[0]).toBe(255)
    // an editor stroke: a 45° slope across x 90..110 m (gx 45..55), heights written in place, normals re-baked
    const t = a.terrain
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 45; gx <= 96; gx++) t.heights[gz * GRID + gx] = 10 + Math.min(gx - 45, 10) * 2 * 1.2
      for (let gx = 44; gx <= 56; gx++) {
        const steep = gx >= 45 && gx < 55
        const ny = steep ? 0.64 : 1
        t.normals.set([Math.round(-Math.sqrt(1 - ny * ny) * 127), Math.round(ny * 127), 0, 0], (gz * GRID + gx) * 4)
      }
    }
    const queued = r.field.invalidate({ x0: 88, z0: -192, x1: 112, z1: 0 })
    expect(queued).toEqual([1])
    settle(r)
    expect(r.field.stats.fills).toBeGreaterThan(fills)
    expect(texel(bakeOf(r, 1)!, 100, 100)[0]).toBe(0)
    expect(texel(bakeOf(r, 1)!, 40, 100)[0]).toBe(255)
    // the height range followed the edit (the window's 16-bit span)
    const e = (r.field as unknown as { entries: Map<number, { hMax: number }> }).entries.get(1)!
    expect(e.hMax).toBeCloseTo(34, 3)
    // null: every resident region
    expect(r.field.invalidate(null).sort()).toEqual([1, 2])
  })
})
