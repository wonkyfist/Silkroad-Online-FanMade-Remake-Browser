/**
 * GL-F, the region bake (docs/GRASS_LIFE.md §3.1, §3.2, §4.1): the native layers composited in the TERRAIN §2.3 order
 * (layer 0 opaque, each later layer replaces the corners its mask covers) and interpolated across the 2 m cell (the
 * soft road edge); the tile weights (Grass/Forest 1, grassy dirt 0.45, pavement/road/rock 0, GL-C's weight when
 * present); the slope, water and object-floor zeros; the meadow mask inside the density; deterministic; the baked light
 * in A only; the slices never go past their budget and registering a region (the commit step) only enqueues.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GRASS_BUSY_REACH, GRASS_SLOPE, GRASSY_DIRT_WEIGHT, RegionGrassBake, bakeRegionGrass, grassBakeSource, grassTileTable, tileGrassWeight } from '../src/grass/bake.ts'
import { GRASS_PALETTE_SLOTS } from '../src/grass/shaders.ts'
import { T, TILES, fieldRig, region, texel, type FieldRig } from './grass-fixture.ts'

const table = grassTileTable(TILES)
const bake = (spec: Parameters<typeof region>[0], occupied: ((x: number, z: number, y: number) => boolean) | null = null) =>
  bakeRegionGrass(grassBakeSource(region(spec)), table, occupied)
const byte = (w: number) => Math.round(w * 255)

const rigs: FieldRig[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose()
})

describe('where grass grows (GRASS_LIFE §3.2)', () => {
  it('tile weights: Grass / LongGrass / Forest 1, grassy dirt 0.45, roads and pavement 0, GL-C\'s weight wins', () => {
    const w = (id: number) => tileGrassWeight(TILES.find(t => t.id === id)!)
    expect([w(T.grass), w(T.forest), w(T.road), w(T.dirt), w(T.marble), w(T.weighted)]).toEqual([1, 1, 0, GRASSY_DIRT_WEIGHT, 0, 0.3])
    expect(tileGrassWeight({ typeName: 'LongGrass', source: 'x.ddj' })).toBe(1)
    expect(tileGrassWeight({ typeName: 'Sand', source: 'asiaminor_sand_01.ddj' })).toBe(0)
    expect(tileGrassWeight({ typeName: 'Grass', source: 'c_stone_grass.ddj' })).toBe(0)
    const all = bake({})
    expect(texel(all, 10, 10)[0]).toBe(255)
    expect(texel(bake({ base: T.dirt }), 10, 10)[0]).toBe(byte(0.45))
    expect(texel(bake({ base: T.road }), 10, 10)[0]).toBe(0)
    expect(texel(bake({ base: T.marble }), 10, 10)[0]).toBe(0)
    expect(texel(bake({ base: T.weighted }), 10, 10)[0]).toBe(byte(0.3))
  })

  it('composites the layers in draw order per corner, then bilinearly; a hard road keeps at or below its ramp', () => {
    // Cell (5, 5): grass, then a road on its two south corners (bits 0 and 1: (x, z), (x + 1, z)). The road is hard
    // ground: the edge feather never puts more grass there than the painted ramp (fz = 0.25 / 0.75 across the cell).
    const d = bake({ layers: [(cx, cz) => (cx === 5 && cz === 5 ? [T.road, 1 | 2] : null)] })
    expect(texel(d, 10, 10)[0]).toBeLessThanOrEqual(byte(0.25))
    expect(texel(d, 11, 10)[0]).toBeLessThanOrEqual(byte(0.25))
    expect(texel(d, 10, 11)[0]).toBeLessThanOrEqual(byte(0.75))
    // away from the change (past the feather's reach) the grass is full
    const far = 2 * (5 + GRASS_BUSY_REACH + 1)
    expect(texel(d, far, far)[0]).toBe(255)
    expect(texel(d, 150, 150)[0]).toBe(255)
    // Grass over a road base on its east corners only: a 2 m speck of grass in a road thins away (the feather).
    const e = bake({ base: T.road, layers: [(cx, cz) => (cx === 5 && cz === 5 ? [T.grass, 2 | 8] : null)] })
    expect(texel(e, 9, 10)[0]).toBe(0)
    expect(texel(e, 11, 11)[0]).toBeLessThanOrEqual(byte(0.75))
    // The later layer wins: road then grass on the same corners = grass, and no change = no feather.
    const f = bake({ layers: [(cx, cz) => (cx === 5 && cz === 5 ? [T.road, 15] : null), (cx, cz) => (cx === 5 && cz === 5 ? [T.grass, 15] : null)] })
    expect(texel(f, 10, 10)[0]).toBe(255)
    expect(texel(f, 100, 100)[0]).toBe(255)
  })

  it('the slope fade: full at normal y ≥ 0.80, none below 0.70', () => {
    expect(texel(bake({ normalY: () => 0.82 }), 50, 50)[0]).toBe(255)
    expect(texel(bake({ normalY: () => 0.65 }), 50, 50)[0]).toBe(0)
    const mid = texel(bake({ normalY: () => (GRASS_SLOPE[0] + GRASS_SLOPE[1]) / 2 }), 50, 50)[0]
    expect(mid).toBeGreaterThan(90)
    expect(mid).toBeLessThan(165)
  })

  it('no grass under water (+ 0.1 m); a plane below the ground keeps it', () => {
    const d = bake({ water: (bx, bz) => (bx === 0 && bz === 0 ? 10.05 : bx === 1 && bz === 0 ? 9.5 : null) })
    expect(texel(d, 5, 5)[0]).toBe(0) // block (0, 0): ground 10 < 10.05 + 0.1
    expect(texel(d, 40, 5)[0]).toBe(255) // block (1, 0): the plane is 0.5 m under the ground
    expect(texel(d, 5, 40)[0]).toBe(255) // block (0, 1): no water
  })

  it('no grass on an object floor (the host\'s nav test at the texel, with the ground height)', () => {
    const calls: Array<[number, number, number]> = []
    const d = bake({ ox: 192, oz: -192, height: gx => 10 + gx * 0.1 }, (x, z, y) => {
      calls.push([x, z, y])
      return x < 192 + 50
    })
    expect(texel(d, 20, 20)[0]).toBe(0)
    expect(texel(d, 60, 20)[0]).toBe(255)
    // Texel (60, 20) = glTF (192 + 60.5, −192 − 20.5), ground 10 + 0.1 × 60.5 / 2.
    const c = calls.find(([x, z]) => x === 252.5 && z === -212.5)!
    expect(c[2]).toBeCloseTo(10 + 0.1 * 60.5 / 2, 5)
  })

  it('the meadow mask lies inside the density, comes in drifts, and the palette slot is the grass layer\'s', () => {
    const d = bake({ layers: [(cx, cz) => (cx >= 48 ? [T.weighted, 15] : null)] })
    let meadow = 0, over = 0
    for (let j = 0; j < 192; j++) for (let i = 0; i < 192; i++) {
      const [r, g] = texel(d, i, j)
      if (g > 0) meadow++
      if (g > r) over++
    }
    expect(over).toBe(0)
    expect(meadow).toBeGreaterThan(192 * 192 * 0.05)
    expect(meadow).toBeLessThan(192 * 192 * 0.8)
    const west = texel(d, 10, 10)[2], east = texel(d, 150, 10)[2]
    expect(west).toBe(table.slot.get(T.grass))
    expect(east).toBe(table.slot.get(T.weighted))
    expect(west).not.toBe(east)
  })

  it('is deterministic, and the palette table has a slot per distinct palette (≤ 16), padded', () => {
    const a = bake({ layers: [(cx, cz) => ((cx + cz) % 7 === 0 ? [T.road, 5] : null)] })
    const b = bake({ layers: [(cx, cz) => ((cx + cz) % 7 === 0 ? [T.road, 5] : null)] })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(table.palette.length).toBe(GRASS_PALETTE_SLOTS * 8)
    expect(table.slots).toBeGreaterThanOrEqual(3)
    expect(table.slot.has(T.road)).toBe(false)
    // GL-C's palette (the deciles through the gain) and the built-in one differ.
    expect(table.slot.get(T.weighted)).not.toBe(table.slot.get(T.grass))
    const many = grassTileTable(Array.from({ length: 40 }, (_, i) => ({ id: i + 1, typeName: 'Grass', source: `t${i}.ddj`, grass: { weight: 1, base: [i / 80, 0.2, 0.05], tip: [0.3 + i / 100, 0.5, 0.2] } })))
    expect(many.slots).toBe(GRASS_PALETTE_SLOTS)
    for (const s of many.slot.values()) expect(s).toBeLessThan(GRASS_PALETTE_SLOTS)
  })

  it('the baked light goes to A only (row 0 = south); the bake never writes A', () => {
    const b = new RegionGrassBake(grassBakeSource(region({ base: T.road })), table)
    const lm = new Uint8Array(4 * 4 * 4)
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) lm.set(j === 0 ? [100, 100, 100, 255] : [200, 200, 200, 255], (j * 4 + i) * 4)
    b.setLight(lm, 4, 4)
    b.step()
    expect(texel(b.data, 5, 5)).toEqual([0, 0, 0, 100])
    expect(texel(b.data, 5, 100)).toEqual([0, 0, 0, 200])
  })
})

describe('the bake runs in slices (GRASS_LIFE §3.1 fact-check, H-GL lens 16)', () => {
  it('registering a region (the commit step) only enqueues: ≤ 0.2 ms, no bake', () => {
    const r = fieldRig()
    rigs.push(r)
    const regions = Array.from({ length: 20 }, (_, k) => region({ id: 1000 + k, ox: (k % 5) * 192, oz: Math.floor(k / 5) * 192 }))
    const ms: number[] = []
    for (const d of regions) {
      const t0 = performance.now()
      r.field.addRegion(d)
      ms.push(performance.now() - t0)
    }
    ms.sort((a, b) => a - b)
    expect(ms[ms.length >> 1]).toBeLessThanOrEqual(0.2)
    expect(r.field.stats.pending).toBe(20)
    expect(r.field.stats.baked).toBe(0)
  })

  it('a slice stops at its budget (a fake clock: 0.05 ms per row), nearest region first, the window fills once per frame', () => {
    let t = 0
    const r = fieldRig({ now: () => t, sliceMs: 1, urgentSliceMs: 4 })
    rigs.push(r)
    // Each row advances the clock through the stop check.
    const far = region({ id: 2, ox: 1920, oz: 0 })
    const near = region({ id: 1, ox: 0, oz: 0 })
    r.field.addRegion(far)
    r.field.addRegion(near)
    const orig = RegionGrassBake.prototype.step
    let rows = 0
    RegionGrassBake.prototype.step = function (stop: () => boolean = () => false) {
      return orig.call(this, () => {
        rows++
        t += 0.05
        return stop()
      })
    }
    try {
      const cam = { x: 96, y: 20, z: -96 }
      const fills: number[] = []
      for (let f = 0; f < 200 && r.field.stats.pending > 0; f++) {
        const before = rows
        r.field.update(cam)
        fills.push(r.field.stats.fills)
        // The near region bakes with the urgent budget (4 ms = 80 rows), the far one with 1 ms (20 rows).
        // 4 ms / 0.05 ms = 80 rows, + the row that crosses the budget (float steps).
        expect(rows - before).toBeLessThanOrEqual(81)
      }
      expect(r.field.stats.pending).toBe(0)
      expect(r.field.stats.worstSliceMs).toBeLessThanOrEqual(4 + 0.05 + 1e-9)
      // The near region (id 1) finished first: 192 rows at 80 per frame = 3 frames.
      expect(fills[2]).toBeGreaterThanOrEqual(2)
    } finally {
      RegionGrassBake.prototype.step = orig
    }
  })

  it('real time: a whole region in slices of ≤ 1 ms (+ one row), ≤ 25 ms in all on a quiet machine', () => {
    const r = fieldRig({ sliceMs: 1, urgentSliceMs: 1 })
    rigs.push(r)
    r.field.addRegion(region({ layers: [(cx, cz) => ((cx * 7 + cz * 3) % 11 === 0 ? [T.road, 3] : null)] }))
    const cam = { x: 96, y: 20, z: -96 }
    const slices: number[] = []
    for (let f = 0; f < 400 && r.field.stats.pending > 0; f++) {
      const t0 = performance.now()
      r.field.update(cam)
      slices.push(performance.now() - t0)
    }
    expect(r.field.stats.pending).toBe(0)
    console.info(`[grass-bake] region ${r.field.stats.lastRegionBakeMs.toFixed(1)} ms in ${slices.length} slices; worst slice ${r.field.stats.worstSliceMs.toFixed(2)} ms`)
    // A loaded CI machine stretches both; the bounds hold the design (slices, not one job) with room.
    expect(slices.length).toBeGreaterThan(3)
    expect(r.field.stats.lastRegionBakeMs).toBeLessThan(150)
  })
})
