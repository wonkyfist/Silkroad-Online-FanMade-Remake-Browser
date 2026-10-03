/**
 * TT-R (docs/TERRAIN_TEX.md §5.2, §7; docs/WAVE_PLAN8.md D7): the terrain's set range admits only the tiles whose set
 * has maps under the policy (the hero sets), so its planes are min(48, hero) deep and created with mips (every hero
 * layer goes down the given-levels upload path that P-LOOK fixed on WebGL2); a non-hero set takes a layer above the range
 * and still swaps in its remastered albedo; the last 8 range layers are kept for tiles at or above the median cover, and
 * a below-median tile never takes one (layers never move, so importance acts at placement only).
 */
import type { BaseTexture } from '@babylonjs/core'
import { describe, expect, it } from 'vitest'
import { planSetRange, TILE_RESERVED_LAYERS, TILE_TIER_LAYERS, TileAtlas, type TileAtlasSetup, type TilePlane, type TileSetInfo, type TileSetRange } from '../src/tile-atlas.ts'

let serial = 0
function fakeTexture(): BaseTexture {
  const t = { id: ++serial, disposed: false, dispose() { t.disposed = true } }
  return t as unknown as BaseTexture
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

const levels = (size: number) => {
  const out: Uint8Array[] = []
  for (let s = size >> 1; s >= 1; s >>= 1) out.push(new Uint8Array(s * s * 4))
  return out
}

/** An atlas whose `prepare` returns `range` (the set range), ORMH maps, an optional tier plane and the albedo swap. */
function rig(opts: { layers: number; range: TileSetRange; sets: (id: number) => boolean; tier?: boolean; growBy?: number }) {
  const created: Array<{ plane: TilePlane; size: number; layers: number }> = []
  const uploads: Array<{ plane: TilePlane; layer: number; first: number; levels: number }> = []
  const tierCalls: number[] = []
  const setup: TileAtlasSetup = {
    maps: { ormh: { size: 2, decode: async () => null } },
    tier: opts.tier
      ? { size: 8, layers: opts.range.layers, has: opts.range.has, decode: async id => ({ data: new Uint8Array(8 * 8 * 4).fill(50 + id), levels: levels(8) }) }
      : null,
    sets: opts.range,
    upgrade: {
      has: opts.sets,
      decode: async (id, _plane, size) => ({ data: new Uint8Array(size * size * 4).fill(150 + id), levels: levels(size) }),
    },
  }
  const a = new TileAtlas({
    scene: null as never,
    size: 4,
    layers: opts.layers,
    growBy: opts.growBy ?? 2,
    decode: async id => new Uint8Array(4 * 4 * 4).fill(id),
    prepare: async () => setup,
    onTierTexture: (_tex, layers) => tierCalls.push(layers),
    create: (size, layers, plane = 'albedo') => {
      created.push({ plane, size, layers })
      return fakeTexture()
    },
    upload: (_tex, layer, rgba, _size, plane = 'albedo', given) => {
      uploads.push({ plane, layer, first: rgba[0]!, levels: given?.length ?? -1 })
      return true
    },
    rebuild: () => fakeTexture(),
  })
  return { a, created, uploads, tierCalls }
}

const info = (entries: Array<[number, boolean, number | null]>) =>
  new Map<number, TileSetInfo>(entries.map(([id, maps, cover]) => [id, { maps, cover }]))

describe('planSetRange: the hero-only set range (TT-R, D7)', () => {
  it('admits only the sets with maps under the policy, min(48, hero) deep', () => {
    const r = planSetRange(info([[1, true, 0.1], [2, false, 0.5], [3, true, null], [4, false, null]]))
    expect(r.layers).toBe(2)
    expect([1, 2, 3, 4].filter(id => r.has(id))).toEqual([1, 3])
    const many = new Map<number, TileSetInfo>()
    for (let id = 0; id < 70; id++) many.set(id, { maps: id < 63, cover: null })
    const big = planSetRange(many)
    expect(big.layers).toBe(TILE_TIER_LAYERS)
    expect(big.has(62)).toBe(true)
    expect(big.has(63)).toBe(false)
    // Without any cover there is no reserve (the field is optional).
    expect(big.reserved ?? 0).toBe(0)
    expect(planSetRange(info([[1, false, 0.3]])).layers).toBe(0)
  })

  it('63 hero sets with cover: the last 8 layers are reserved for the tiles at or above the median cover', () => {
    const sets = new Map<number, TileSetInfo>()
    for (let id = 0; id < 63; id++) sets.set(id, { maps: true, cover: (id + 1) / 1000 })
    sets.set(100, { maps: false, cover: 0.9 })
    const r = planSetRange(sets)
    expect(r.layers).toBe(48)
    expect(r.reserved).toBe(TILE_RESERVED_LAYERS)
    // The median of 1..63 ‰ is 32 ‰ (id 31): ids 31..62 are important, the rest are not; a non-hero set never is.
    expect(r.important!(31)).toBe(true)
    expect(r.important!(62)).toBe(true)
    expect(r.important!(30)).toBe(false)
    expect(r.important!(100)).toBe(false)
  })

  it('the reserve never squeezes a below-median tile out of a range that holds every hero tile', () => {
    // 10 hero tiles, 5 below the median: a 10-layer range keeps 5 layers open below the reserve.
    const sets = new Map<number, TileSetInfo>()
    for (let id = 0; id < 10; id++) sets.set(id, { maps: true, cover: id / 100 })
    const r = planSetRange(sets)
    expect(r.layers).toBe(10)
    expect(r.reserved).toBe(5)
    // A hero tile without a cover counts as below the median.
    const r2 = planSetRange(info([[1, true, 0.2], [2, true, 0.4], [3, true, null]]))
    expect(r2.important!(3)).toBe(false)
  })
})

describe('TileAtlas with the hero-only range (TT-R)', () => {
  it('the map and tier planes are created at min(48, hero) and every hero layer gets the given-levels upload', async () => {
    const sets = new Map<number, TileSetInfo>()
    for (let id = 1; id <= 60; id++) sets.set(id, { maps: id <= 52, cover: null })
    const range = planSetRange(sets)
    const { a, created, uploads, tierCalls } = rig({ layers: 64, range, sets: id => sets.has(id), tier: true })
    await a.acquire([1, 2, 3, 55], () => 0)
    await settle()
    expect(created.map(c => [c.plane, c.layers])).toEqual([['albedo', 64], ['ormh', 48], ['tier', 48]])
    expect(tierCalls).toEqual([48])
    expect(a.setLayers).toBe(48)
    for (const id of [1, 2, 3]) {
      const layer = a.layerOf(id)!
      expect(layer).toBeLessThan(48)
      const at = uploads.filter(u => u.layer === layer && u.plane !== 'albedo')
      expect(at.map(u => u.plane).sort()).toEqual(['ormh', 'ormh', 'tier', 'tier'])
      // Mipped planes: every tier and ORMH upload of a hero layer carries its full level chain.
      for (const u of at) expect(u.levels).toBe(u.plane === 'tier' ? 3 : 1)
    }
  })

  it('a non-hero set takes a layer above the range and still swaps in its set albedo (only the albedo)', async () => {
    const range = planSetRange(info([[1, true, null], [2, true, null], [7, false, null]]))
    const { a, uploads } = rig({ layers: 6, range, sets: id => id === 1 || id === 2 || id === 7, tier: true })
    await a.acquire([1, 2, 7, 9], () => 0)
    await settle()
    expect(a.setLayers).toBe(2)
    const layer = a.layerOf(7)!
    expect(layer).toBeGreaterThanOrEqual(2)
    expect(a.layerOf(9)!).toBeGreaterThanOrEqual(2)
    const swapped = uploads.filter(u => u.layer === layer && u.first === 157)
    expect(swapped.map(u => u.plane)).toEqual(['albedo'])
    // A tile without a set is never upgraded.
    expect(uploads.filter(u => u.layer === a.layerOf(9)! && u.first >= 150)).toEqual([])
  })

  it('a below-median tile never takes a reserved layer: it overflows above the range, else the array grows', async () => {
    // A 4-layer range with its last 2 layers (2, 3) reserved for tiles 10..12; tiles 1..3 are below the median.
    const range: TileSetRange = { layers: 4, has: id => id < 20, reserved: 2, important: id => id >= 10 }
    const { a } = rig({ layers: 6, range, sets: id => id < 20 })
    await a.acquire([1, 2, 3], () => 0)
    expect(a.reservedLayers).toBe(2)
    expect([a.layerOf(1), a.layerOf(2)].sort()).toEqual([0, 1])
    expect(a.layerOf(3)!).toBeGreaterThanOrEqual(4)
    await a.acquire([10, 11], () => 0)
    expect([a.layerOf(10), a.layerOf(11)].sort()).toEqual([2, 3])
  })

  it('a below-median tile never evicts into the reserve; an important tile takes the open layers first', async () => {
    const range: TileSetRange = { layers: 4, has: id => id < 20, reserved: 2, important: id => id >= 10 }
    const { a } = rig({ layers: 4, range, sets: id => id < 20, growBy: 1 })
    await a.acquire([10, 11, 12], () => 0)
    expect([a.layerOf(10), a.layerOf(11), a.layerOf(12)]).toEqual([0, 1, 2])
    a.release([10, 11, 12])
    await a.acquire([1, 2], () => 0)
    expect([a.layerOf(1), a.layerOf(2)].sort()).toEqual([0, 1])
    // Only the reserved layers 2 (tile 12, unreferenced) and 3 (free) are left: tile 3 grows the array instead.
    await a.acquire([3], () => 0)
    expect(a.layerOf(3)!).toBe(4)
    expect(a.capacity).toBe(5)
    expect(a.layerOf(12)).toBe(2)
  })
})
