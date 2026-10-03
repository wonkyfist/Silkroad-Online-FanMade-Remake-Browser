/**
 * The per-region wet map (docs/WEATHER.md §6.2, docs/WAVE_PLAN3.md D22): a bowl holds a puddle at its centre, a slope
 * and a water tile hold none, the vertex normal round-trips through G/A and the black fallback reads as "no wet map";
 * on the real jangan-fields export (skipped without work/out-opt) the coverage matches the prototype's measurement
 * (2.5 % of vertices ≥ 0.5, 25.7 % ≥ 0.2) and a region builds in about a millisecond.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GRID, decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { TERRAIN_SURFACE, TERRAIN_SURFACE_PARAMS, surfaceAlpha, surfaceFromAlpha } from '../src/index.ts'
import { WET_MAP_SIZE, buildWetMap, surfaceLookup, wetMapCoverage, wetMapNormal } from '../src/weather/wetmap.ts'

const n = GRID

/** A synthetic region: heights from `h(gx, gz)`, normals from central differences (glTF: z = −2 gz), one tile id. */
function region(h: (gx: number, gz: number) => number, tile = 1) {
  const heights = new Float32Array(n * n)
  for (let gz = 0; gz < n; gz++) for (let gx = 0; gx < n; gx++) heights[gz * n + gx] = h(gx, gz)
  const normals = new Int8Array(n * n * 4)
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const at = (x: number, z: number) => heights[Math.min(n - 1, Math.max(0, z)) * n + Math.min(n - 1, Math.max(0, x))]!
      const dx = (at(gx + 1, gz) - at(gx - 1, gz)) / 4
      const dz = -(at(gx, gz + 1) - at(gx, gz - 1)) / 4
      const l = Math.hypot(dx, 1, dz)
      normals.set([Math.round((-dx / l) * 127), Math.round((1 / l) * 127), Math.round((-dz / l) * 127), 0], (gz * n + gx) * 4)
    }
  }
  return { heights, normals, textures: new Uint16Array(n * n).fill(tile) }
}

const DIRT = 1
/** A 0.5 m deep pit about 6 m across in a flat plain at 5 m. */
const pit = (x: number, z: number) => 5 - 0.5 * Math.exp(-((x - 48) ** 2 + (z - 48) ** 2) / 8)
const WATER = 2
const surface = (id: number) => (id === DIRT ? TERRAIN_SURFACE.dirt : id === WATER ? TERRAIN_SURFACE.water : TERRAIN_SURFACE.generic)
const R = (map: Uint8Array, gx: number, gz: number) => map[(gz * n + gx) * 4]! / 255

describe('buildWetMap on synthetic terrain', () => {
  it('a pit: the centre holds a puddle, less toward its rim', () => {
    const map = buildWetMap(region(pit), surface)
    expect(map.length).toBe(WET_MAP_SIZE * WET_MAP_SIZE * 4)
    expect(R(map, 48, 48)).toBeGreaterThan(0.5)
    // Flat enough to be eligible, but not a basin: the 0.3 floor (× dirt eligibility 1).
    expect(R(map, 48, 48)).toBeGreaterThan(R(map, 44, 48))
    expect(wetMapNormal(map, 48, 48)).not.toBeNull()
    expect(wetMapNormal(map, 48, 48)![1]).toBeGreaterThan(0.99)
  })

  it('a flat plain: every vertex at the 0.3 floor × eligibility (dirt 1, generic 0.5)', () => {
    const dirt = buildWetMap(region(() => 5, DIRT), surface)
    const generic = buildWetMap(region(() => 5, 9), surface)
    expect(R(dirt, 30, 30)).toBeCloseTo(0.3, 2)
    expect(R(generic, 30, 30)).toBeCloseTo(0.3 * TERRAIN_SURFACE_PARAMS[TERRAIN_SURFACE.generic]!.puddle, 2)
  })

  it('a slope holds no puddle (flatness 0), and its normal leans away from up', () => {
    const map = buildWetMap(region(x => x * 0.8), surface)
    expect(R(map, 40, 40)).toBe(0)
    expect(map[(40 * n + 40) * 4 + 2]).toBe(0)
    const nrm = wetMapNormal(map, 40, 40)!
    expect(nrm[0]).toBeLessThan(-0.3)
  })

  it('a water tile holds no puddle, even in a pit', () => {
    const map = buildWetMap(region(pit, WATER), surface)
    expect(R(map, 48, 48)).toBe(0)
  })

  it('the 1 × 1 black fallback (0, 0, 0, 255) is "no wet map": no normal, no potential', () => {
    const black = new Uint8Array(n * n * 4)
    for (let i = 3; i < black.length; i += 4) black[i] = 255
    expect(wetMapNormal(black, 10, 10)).toBeNull()
    expect(wetMapCoverage(black, 0.01)).toBe(0)
  })

  it('the layer-map class the chunks read survives the alpha round trip for every surface class', () => {
    for (let c = 0; c < TERRAIN_SURFACE_PARAMS.length; c++) expect(surfaceFromAlpha(surfaceAlpha(c) / 255)).toBe(c)
    expect(surfaceLookup([{ id: 7, typeName: 'Mud' }, { id: 8, typeName: 'Dirt', file: 'tiles/c_marble_jang_01.png' }])(7)).toBe(TERRAIN_SURFACE.dirt)
    expect(surfaceLookup([{ id: 8, typeName: 'Dirt', file: 'tiles/c_marble_jang_01.png' }])(8)).toBe(TERRAIN_SURFACE.stone)
    expect(surfaceLookup([])(123)).toBe(TERRAIN_SURFACE.generic)
  })
})

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const FIELDS = join(REPO, 'work', 'out-opt', 'world', 'jangan-fields')

describe.skipIf(!existsSync(join(FIELDS, 'manifest.json')))('buildWetMap on the real jangan-fields export', () => {
  it('coverage matches the prototype (≈ 2.5 % ≥ 0.5, ≈ 26 % ≥ 0.2) and a region builds in a few ms', () => {
    const m = JSON.parse(readFileSync(join(FIELDS, 'manifest.json'), 'utf8')) as WorldManifest
    const surfaceOf = surfaceLookup(m.tiles as { id: number; typeName?: string | null; file?: string; source?: string }[])
    let cells = 0, p50 = 0, p20 = 0, total = 0, count = 0
    const out = new Uint8Array(WET_MAP_SIZE * WET_MAP_SIZE * 4)
    for (const r of m.regions) {
      const t = decodeTerrainBin(new Uint8Array(readFileSync(join(FIELDS, r.terrain.file))))
      const t0 = performance.now()
      buildWetMap(t, surfaceOf, out)
      total += performance.now() - t0
      count++
      const k = WET_MAP_SIZE * WET_MAP_SIZE
      cells += k
      p50 += wetMapCoverage(out, 0.5) * k
      p20 += wetMapCoverage(out, 0.2) * k
    }
    expect(count).toBeGreaterThan(100)
    const s50 = p50 / cells, s20 = p20 / cells
    expect(s50).toBeGreaterThan(0.01)
    expect(s50).toBeLessThan(0.05)
    expect(s20).toBeGreaterThan(0.15)
    expect(s20).toBeLessThan(0.35)
    // The prototype measured 0.66–1.1 ms with a 5 × 5 loop; the summed-area table is cheaper. Loose on a loaded PC.
    expect(total / count).toBeLessThan(5)
  })
})
