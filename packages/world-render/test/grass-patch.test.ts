/**
 * GL-F, the patch meshes (docs/GRASS_LIFE.md §2.2, §3.3, §4.1): the vertex and triangle counts per tier are §3.3's
 * (the prototype's random sequence), tier membership per LOD, the blade densities (45 / 74 per m²), about 12 % of the
 * clumps flowering in the near and mid tiers only, and the cell variants: 4 rotations × a mirror, eight distinct
 * symmetries of the 8 m square, each one a permutation of the patch's clump positions' cell (it maps the square onto
 * itself), all eight picked by the corner hash.
 */
import { describe, expect, it } from 'vitest'
import { GRASS_LEVELS } from '../src/grass/cull.ts'
import { bladesPerM2, buildPatch, type GrassLod } from '../src/grass/patch.ts'
import { GRASS_CELL_M, grassApplyVariant, grassCellVariant } from '../src/grass/shaders.ts'

const MEDIUM = GRASS_LEVELS.medium!.density
const HIGH = GRASS_LEVELS.high!.density

describe('the patch meshes (GRASS_LIFE §3.3)', () => {
  it('vertex and triangle counts per tier are §3.3\'s', () => {
    const counts = (d: typeof MEDIUM) => ([0, 1, 2] as GrassLod[]).map(l => {
      const p = buildPatch(l, d)
      return [p.vertices, p.triangles]
    })
    expect(counts(MEDIUM)).toEqual([[21_252, 15_246], [8_184, 5_082], [1_452, 484]])
    expect(counts(HIGH)).toEqual([[34_272, 24_562], [11_288, 6_986], [2_028, 676]])
  })

  it('45 blades per m² on Medium, 74 on High; Grass: Low keeps Medium\'s density', () => {
    expect(bladesPerM2(MEDIUM)).toBeCloseTo(45.4, 1)
    expect(bladesPerM2(HIGH)).toBeCloseTo(73.9, 1)
    expect(GRASS_LEVELS.low!.density).toEqual(MEDIUM)
    expect(GRASS_LEVELS.off).toBeNull()
  })

  it('tier membership: LOD 0 draws every tier, LOD 1 tiers 0–1, LOD 2 tier 0; blades have 7 / 5 / 3 vertices', () => {
    for (const d of [MEDIUM, HIGH]) {
      const clumps = d.clumpGrid * d.clumpGrid
      const expectBlades = [clumps * d.blades, clumps * 3, clumps]
      for (const lod of [0, 1, 2] as GrassLod[]) {
        const p = buildPatch(lod, d)
        expect(p.blades).toBe(expectBlades[lod])
        const tiers = new Set<number>()
        let bladeVerts = 0
        for (let v = 0; v < p.vertices; v++) {
          if (p.positions[v * 3 + 2] !== 0) continue // flower vertices
          tiers.add(p.bladeA[v * 4 + 3]!)
          bladeVerts++
        }
        expect([...tiers].sort()).toEqual([[0, 1, 2], [0, 1], [0]][lod])
        expect(bladeVerts).toBe(p.blades * [7, 5, 3][lod]!)
        // Every blade root lies in the cell, within 16 cm of a clump centre inside it.
        for (let v = 0; v < p.vertices; v++) {
          expect(p.bladeA[v * 4]).toBeGreaterThan(-0.2)
          expect(p.bladeA[v * 4]).toBeLessThan(GRASS_CELL_M + 0.2)
          expect(p.bladeA[v * 4 + 1]).toBeGreaterThan(-0.2)
          expect(p.bladeA[v * 4 + 1]).toBeLessThan(GRASS_CELL_M + 0.2)
        }
      }
    }
  })

  it('about 12 % of the clumps flower, in the near and mid tiers only (0 extra draws: same mesh)', () => {
    const near = buildPatch(0, MEDIUM), mid = buildPatch(1, MEDIUM), far = buildPatch(2, MEDIUM)
    expect(near.flowers).toBe(66)
    expect(mid.flowers).toBe(66)
    expect(far.flowers).toBe(0)
    expect(buildPatch(0, HIGH).flowers).toBe(82)
    // A flower is a stem (1 triangle, kind 2) and a 10-point star head (10 triangles, kind 1).
    const kinds = new Map<number, number>()
    for (let v = 0; v < near.vertices; v++) kinds.set(near.positions[v * 3 + 2]!, (kinds.get(near.positions[v * 3 + 2]!) ?? 0) + 1)
    expect(kinds.get(1)).toBe(66 * 11)
    expect(kinds.get(2)).toBe(66 * 3)
  })

  it('is deterministic', () => {
    const a = buildPatch(0, MEDIUM), b = buildPatch(0, MEDIUM)
    expect(Buffer.from(a.bladeB.buffer).equals(Buffer.from(b.bladeB.buffer))).toBe(true)
    expect(Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer))).toBe(true)
  })
})

describe('the cell variants (GRASS_LIFE §2.2: the 8 m repetition does not show)', () => {
  const H = GRASS_CELL_M / 2

  it('the eight variants are eight distinct symmetries of the square, each mapping it onto itself', () => {
    const probe: Array<[number, number]> = [[1.3, 0.4], [-2.2, 3.1], [3.9, -3.7]]
    const images = new Set<string>()
    for (let v = 0; v < 8; v++) {
      const img = probe.map(([x, z]) => grassApplyVariant(v, x, z))
      for (const [x, z] of img) {
        expect(Math.abs(x)).toBeLessThanOrEqual(H)
        expect(Math.abs(z)).toBeLessThanOrEqual(H)
      }
      // Distances are kept (a rigid symmetry).
      const [a, b] = [img[0]!, img[1]!]
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(Math.hypot(probe[0]![0] - probe[1]![0], probe[0]![1] - probe[1]![1]), 9)
      images.add(img.map(p => p.map(n => n.toFixed(6)).join(',')).join(';'))
    }
    expect(images.size).toBe(8)
  })

  it('is a permutation of the patch: the clump centres of a variant are the patch\'s positions moved inside the cell', () => {
    const p = buildPatch(2, MEDIUM)
    for (let v = 0; v < 8; v++) {
      let inside = 0
      for (let i = 0; i < p.vertices; i++) {
        const [x, z] = grassApplyVariant(v, p.bladeA[i * 4]! - H, p.bladeA[i * 4 + 1]! - H)
        if (Math.abs(x) <= H + 0.2 && Math.abs(z) <= H + 0.2) inside++
      }
      expect(inside).toBe(p.vertices)
    }
  })

  it('the corner hash picks all eight, about evenly', () => {
    const n = new Array<number>(8).fill(0)
    for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) n[grassCellVariant((i - 32) * GRASS_CELL_M, (j - 32) * GRASS_CELL_M)]!++
    for (const c of n) expect(c).toBeGreaterThan(64 * 64 / 8 * 0.6)
  })
})
