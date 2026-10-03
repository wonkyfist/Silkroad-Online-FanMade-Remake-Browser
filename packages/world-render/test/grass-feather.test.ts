/**
 * LOOK-GRASS (the X1 review's look items 1, 2 and 7, `work/tmp/w10r/look-notes.md`): the grass bake's edge feather
 * (grass/bake.ts `GRASS_EDGE_WARP_M`). A painted grass edge meanders and thins over several metres instead of ending
 * in a straight wall; soft bare ground (sand) takes thin tongues, hard ground (paving, roads) none; grassy dirt next
 * to grass is a ramp, not a bald strip; two palettes interleave across their border; the feather reads the neighbour
 * regions past the border (no seam) and GrassField bakes a region again when a neighbour it lacked arrives; no grass
 * grows under the coast's sea, also when the coast field arrives after the bake.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  GRASS_BUSY_REACH,
  GRASS_EDGE_FEATHER_M,
  GRASS_EDGE_WARP_M,
  GRASS_HARD_SHARE,
  GRASS_PALETTE_BLEND_M,
  GRASSY_DIRT_WEIGHT,
  RegionGrassBake,
  bakeRegionGrass,
  grassBakeSource,
  grassNeighbourBit,
  grassTileTable,
  type GrassSea,
} from '../src/grass/bake.ts'
import { T, TILES, fieldRig, region, texel, type FieldRig, type RegionSpec } from './grass-fixture.ts'

const table = grassTileTable(TILES)
const bake = (spec: RegionSpec, opts: Parameters<typeof bakeRegionGrass>[2] = null) => bakeRegionGrass(grassBakeSource(region(spec)), table, opts)
/** The painted line: cells cz < 48 (metres j < 96 north of the south edge) carry `bare`, the rest grass. */
const LINE = 96
const southOf = (bare: number): RegionSpec => ({ layers: [(_cx, cz) => (cz < LINE / 2 ? [bare, 15] : null)] })

/** Per column: the first metre (from the south) whose density reaches half, or 192. */
function halfLine(d: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i < 192; i++) {
    let j = 0
    while (j < 192 && texel(d, i, j)[0] < 128) j++
    out.push(j)
  }
  return out
}

const rigs: FieldRig[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

describe('the edge feather (look item 1)', () => {
  it('a straight sand edge meanders and thins over several metres, never a straight wall', () => {
    const d = bake(southOf(T.sand))
    const e = halfLine(d)
    const lo = Math.min(...e), hi = Math.max(...e)
    // the half-density line wanders by metres across the region (the painted line is one row)
    expect(hi - lo).toBeGreaterThanOrEqual(6)
    // the mean over a band 2..5 m inside the painted line is thinned, not full
    let band = 0, n = 0
    for (let j = LINE + 2; j < LINE + 5; j++) for (let i = 0; i < 192; i++) {
      band += texel(d, i, j)[0]
      n++
    }
    expect(band / n).toBeGreaterThan(20)
    expect(band / n).toBeLessThan(235)
    // beyond the warp and the feather the grass is full again
    for (let i = 0; i < 192; i += 3) expect(texel(d, i, LINE + GRASS_EDGE_WARP_M + GRASS_EDGE_FEATHER_M + 4)[0]).toBe(255)
  })

  it('soft sand takes thin tongues past the painted line; hard paving none', () => {
    const sand = bake(southOf(T.sand))
    let spill = 0, deep = 0
    for (let j = 0; j < LINE - 1; j++) for (let i = 0; i < 192; i++) {
      if (!texel(sand, i, j)[0]) continue
      spill++
      if (j < LINE - GRASS_EDGE_WARP_M - 2) deep++
    }
    expect(spill).toBeGreaterThan(0)
    expect(deep).toBe(0)
    const marble = bake(southOf(T.marble))
    // the painted ramp ends inside the last bare cell (metres 94, 95): nothing south of it
    for (let j = 0; j < LINE - 2; j++) for (let i = 0; i < 192; i++) expect(texel(marble, i, j)[0]).toBe(0)
    // and the verge is narrow: the half line stays within the hard share of the reach
    const e = halfLine(marble)
    expect(Math.max(...e)).toBeLessThanOrEqual(LINE + Math.ceil((GRASS_EDGE_WARP_M + GRASS_EDGE_FEATHER_M) * GRASS_HARD_SHARE) + 3)
  })

  it('grassy dirt next to grass ramps down to its own density: no bald strip', () => {
    const d = bake({ layers: [(cx) => (cx >= 48 ? [T.dirt, 15] : null)] })
    let min = 255
    for (let j = 0; j < 192; j++) for (let i = 0; i < 192; i++) min = Math.min(min, texel(d, i, j)[0])
    expect(min).toBeGreaterThanOrEqual(Math.round(GRASSY_DIRT_WEIGHT * 255) - 1)
  })
})

describe('the palette blend (look item 7)', () => {
  it('two palettes interleave across their border instead of meeting in a line', () => {
    const a = table.slot.get(T.grass)!, b = table.slot.get(T.forest)!
    expect(a).not.toBe(b)
    const d = bake({ layers: [(cx) => (cx >= 48 ? [T.forest, 15] : null)] })
    const reach = Math.ceil(GRASS_EDGE_WARP_M + GRASS_PALETTE_BLEND_M) + 2
    const firstB: number[] = []
    let mixA = 0, mixB = 0
    for (let j = 0; j < 192; j++) {
      expect(texel(d, 96 - reach, j)[2]).toBe(a)
      expect(texel(d, 96 + reach, j)[2]).toBe(b)
      let i = 0
      while (i < 192 && texel(d, i, j)[2] !== b) i++
      firstB.push(i)
      for (let k = 94; k < 98; k++) {
        if (texel(d, k, j)[2] === a) mixA++
        else mixB++
      }
    }
    // both palettes show next to the border, and where the second one starts varies from row to row by metres
    expect(mixA).toBeGreaterThan(192 * 4 * 0.15)
    expect(mixB).toBeGreaterThan(192 * 4 * 0.15)
    expect(Math.max(...firstB) - Math.min(...firstB)).toBeGreaterThanOrEqual(6)
    // density is untouched by a palette change (both tiles are full grass)
    for (let j = 0; j < 192; j += 7) for (let i = 0; i < 192; i += 7) expect(texel(d, i, j)[0]).toBe(255)
  })
})

describe('across region borders', () => {
  it('the feather reads the neighbour\'s cells: sand just east of the border thins the grass west of it', () => {
    const west = region({ id: 1, ox: 0, oz: 0 })
    const east = region({ id: 2, ox: 192, oz: 0, layers: [(cx, cz) => (cx < 6 && cz >= 20 && cz < 70 ? [T.sand, 15] : null)] })
    const nb = (dx: number, dz: number) => (dx === 1 && dz === 0 ? grassBakeSource(east) : null)
    const b = new RegionGrassBake(grassBakeSource(west), table, { neighbours: nb })
    b.step()
    expect(b.neighbourMask).toBe(grassNeighbourBit(1, 0))
    let thinned = 0
    for (let j = 50; j < 130; j++) for (let i = 186; i < 192; i++) if (texel(b.data, i, j)[0] < 255) thinned++
    expect(thinned).toBeGreaterThan(20)
    // without the neighbour the region cannot know: full grass there (the seam GrassField's bake-again removes)
    const alone = bakeRegionGrass(grassBakeSource(west), table)
    for (let j = 50; j < 130; j++) for (let i = 186; i < 192; i++) expect(texel(alone, i, j)[0]).toBe(255)
    // and both sides agree texel for texel on the noise: the east region's west columns thin too
    const eb = bakeRegionGrass(grassBakeSource(east), table, { neighbours: (dx, dz) => (dx === -1 && dz === 0 ? grassBakeSource(west) : null) })
    let eastThin = 0
    for (let j = 50; j < 130; j++) for (let i = 12; i < 20; i++) if (texel(eb, i, j)[0] < 255) eastThin++
    expect(eastThin).toBeGreaterThan(20)
  })

  it('GrassField bakes a region again when a neighbour it lacked arrives, keeping its light', () => {
    const r = fieldRig({ sliceMs: 1000, urgentSliceMs: 1000 })
    rigs.push(r)
    const west = region({ id: 1, ox: 0, oz: 0 })
    r.field.addRegion(west)
    const cam = { x: 96, y: 20, z: -96 }
    for (let f = 0; f < 10 && r.field.stats.pending; f++) r.field.update(cam)
    expect(r.field.stats.pending).toBe(0)
    const entry = (r.field as unknown as { entries: Map<number, { grass: Uint8Array | null; bake: RegionGrassBake | null }> }).entries.get(1)!
    entry.grass![3] = 77 // a baked light texel
    expect(entry.bake!.neighbourMask).toBe(0)
    const before = entry.grass!
    r.field.addRegion(region({ id: 2, ox: 192, oz: 0, layers: [(cx, cz) => (cx < 6 && cz >= 20 && cz < 70 ? [T.sand, 15] : null)] }))
    expect(r.field.stats.pending).toBe(2)
    // the old grass shows until the new bake lands
    expect(entry.grass).toBe(before)
    for (let f = 0; f < 10 && r.field.stats.pending; f++) r.field.update(cam)
    expect(r.field.stats.pending).toBe(0)
    expect(entry.grass).not.toBe(before)
    expect(entry.grass![3]).toBe(77)
    expect(entry.bake!.neighbourMask).toBe(grassNeighbourBit(1, 0))
    let thinned = 0
    for (let j = 50; j < 130; j++) for (let i = 186; i < 192; i++) if (texel(entry.grass!, i, j)[0] < 255) thinned++
    expect(thinned).toBeGreaterThan(20)
  })
})

describe('the coast\'s sea (look item 2: the S1 strip)', () => {
  // the sea: everything south of metre 60 of a region at the origin, and a pool at metres 0..20 east × 100..120 north;
  // sea level 10.5 m over a ground that rises north (9 + 0.05 × (j / 2) m: the sea level at metre 60)
  const seaAt = (x: number, z: number) => z > -60 || (x < 20 && z < -100 && z > -120)
  const sea: GrassSea = {
    seaLevelM: 10.5,
    seaAt,
    // the shoreline distance on land: to the south sea or to the pool (box distance), as the field's G channel
    sample: (x, z) => {
      const pool = Math.hypot(Math.max(0, x - 20), Math.max(0, -120 - z, z + 100))
      // signed like the field's (− on land)
      return { sea: seaAt(x, z) ? 1 : 0, distanceM: -Math.min(-60 - z, pool) }
    },
  }
  const rising = { height: (_gx: number, gz: number) => 9 + gz * 0.05 }

  it('no grass under the sea; a ragged ramp above it; dry ground and inland basins keep their grass', () => {
    const d = bake(rising, { sea: () => sea })
    expect(texel(d, 50, 30)[0]).toBe(0)
    expect(texel(d, 50, 59)[0]).toBe(0)
    // the ramp: none up to 10.6 m (metre 64), full from 11.4 m (metre 96); in between it meanders (noise)
    const firstFull: number[] = []
    for (let i = 0; i < 192; i++) {
      expect(texel(d, i, 63)[0]).toBe(0)
      expect(texel(d, i, 97)[0]).toBe(255)
      let j = 60
      while (j < 192 && texel(d, i, j)[0] < 255) j++
      firstFull.push(j)
    }
    expect(Math.max(...firstFull) - Math.min(...firstFull)).toBeGreaterThanOrEqual(4)
    // ground below the sea level more than 32 m from the sea keeps its grass (an inland basin: Jangan's own floor)
    const basin = bake({ height: () => 8 }, { sea: () => sea })
    expect(texel(basin, 60, 110)[0]).toBe(255)
    expect(texel(basin, 10, 110)[0]).toBe(0)
    expect(texel(basin, 31, 110)[0]).toBeGreaterThan(0)
    expect(texel(basin, 31, 110)[0]).toBeLessThan(255)
    // without the field's sample: the sea at the texel or 16 m around it
    const plain = bake({ height: () => 8 }, { sea: () => ({ seaLevelM: 10.5, seaAt }) })
    expect(texel(plain, 60, 110)[0]).toBe(255)
    expect(texel(plain, 10, 110)[0]).toBe(0)
    // no coast: today's bake
    expect(texel(bake(rising), 50, 30)[0]).toBe(255)
  })

  it('a coast field that arrives after the bake clears the sea out of it (GrassField, one region per frame)', () => {
    let coast: GrassSea | null = null
    const r = fieldRig({ sliceMs: 1000, urgentSliceMs: 1000, coast: () => coast })
    rigs.push(r)
    r.field.addRegion(region({ id: 1, ox: 0, oz: 0, ...rising }))
    const cam = { x: 96, y: 20, z: -96 }
    for (let f = 0; f < 10 && r.field.stats.pending; f++) r.field.update(cam)
    expect(r.field.densityAt(50.5, -30.5)).toBe(1)
    coast = sea
    r.field.update(cam)
    r.field.update(cam)
    expect(r.field.densityAt(50.5, -30.5)).toBe(0)
    expect(r.field.densityAt(50.5, -100.5)).toBe(1)
    const b = new RegionGrassBake(grassBakeSource(region(rising)), table)
    b.step()
    expect(b.minGrassY).toBeCloseTo(9 + 0.05 * 0.25, 2)
    expect(b.clearSea({ seaLevelM: 0, seaAt: () => true })).toBe(false)
    expect(b.clearSea(sea)).toBe(true)
    // within a step of a bake that had the sea from the start (density × the ramp, rounded twice)
    const ref = bakeRegionGrass(grassBakeSource(region(rising)), table, { sea: () => sea })
    for (let j = 0; j < 192; j += 3) for (let i = 0; i < 192; i += 3) expect(Math.abs(texel(b.data, i, j)[0] - texel(ref, i, j)[0])).toBeLessThanOrEqual(1)
  })
})

describe('the shore test cost', () => {
  it('a region far from the sea tests the field on a coarse grid only, never per texel', () => {
    let calls = 0
    const far: GrassSea = {
      seaLevelM: 10.5,
      seaAt: x => (calls++, x > 5000),
      sample: (x) => (calls++, { sea: x > 5000 ? 1 : 0, distanceM: -63.75 }),
    }
    const d = bake({ height: () => 8 }, { sea: () => far })
    expect(texel(d, 96, 96)[0]).toBe(255)
    expect(calls).toBeLessThan(2 * 20 * 20)
  })
})

describe('the plain bake stays the plain bake', () => {
  it('a region with no change is the bilinear weight and one slot everywhere, and the reach covers the feather', () => {
    const d = bake({})
    for (let j = 0; j < 192; j += 5) for (let i = 0; i < 192; i += 5) expect(texel(d, i, j).slice(0, 1)).toEqual([255])
    expect(GRASS_BUSY_REACH * 2).toBeGreaterThanOrEqual(GRASS_EDGE_WARP_M + Math.max(GRASS_EDGE_FEATHER_M, GRASS_PALETTE_BLEND_M))
  })
})
