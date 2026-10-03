/**
 * Grass and plant scatter (docs/WAVE_PLAN.md §6 W5-G): the density table, deterministic placement per region seed, no
 * plants on stone / road / water / object floors, the level fraction, and the renderer's chunk lifecycle (NullEngine):
 * lazy generation around the camera, level changes, and disposal with the region, including through RegionStreamer.
 */
import { NullEngine, Scene, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { GRID, terrainHeightAt } from '../../convert/src/world/format.ts'
import type { TileTexture, WorldRegion } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  CHUNKS_PER_REGION,
  RegionStreamer,
  SCATTER_KINDS,
  SCATTER_PRESETS,
  STREAM_DEFAULTS,
  WorldScatter,
  chunkSeed,
  scatterChunk,
  tileDensityTable,
  tileScatterDensity,
  type RegionData,
  type ScatterSource,
} from '../src/index.ts'
import { CX, CZ, fakeModels, makeFixture, makeWorld, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const tile = (id: number, typeName: string | null, source: string): TileTexture =>
  ({ id, typeName, source, file: `tiles/${source.replace('.ddj', '.webp')}`, width: 4, height: 4, category: '' })

/** 1 grass, 2 the Jangan marble (typed Dirt), 3 plain dirt, 4 water, 5 stone. */
const TILES: TileTexture[] = [
  tile(1, 'Grass', 'c_grass_fld_03.ddj'),
  tile(2, 'Dirt', 'c_marble_jang_08_1.ddj'),
  tile(3, 'Dirt', 'c_dust_fld_01.ddj'),
  tile(4, 'Water', 'oaho_water_01.ddj'),
  tile(5, 'Stone', 'c_stone_hmfld_01.ddj'),
]
const DENSITY = tileDensityTable(TILES)
const densityOf = (id: number) => DENSITY.get(id) ?? 0

/** Tile id at vertex (gx, gz) of the synthetic region: grass west, a marble road, dirt south-east, water north-east. */
function tileAt(gx: number, gz: number): number {
  if (gx >= 40 && gx <= 43) return 2
  if (gx > 43 && gz < 48) return gx > 88 ? 5 : 3
  if (gx >= 80 && gz >= 48) return 4
  return 1
}

function blocks(): WorldRegion['blocks'] {
  return Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null }))
}

function makeSource(id = (97 << 8) | 168, origin: [number, number, number] = [0, 0, 0]): ScatterSource {
  const n = GRID * GRID
  const heights = new Float32Array(n)
  const normals = new Int8Array(n * 4)
  const textures = new Uint16Array(n)
  for (let gz = 0; gz < GRID; gz++) {
    for (let gx = 0; gx < GRID; gx++) {
      const i = gz * GRID + gx
      heights[i] = 10 + Math.sin(gx / 9) * 0.8 + Math.cos(gz / 7) * 0.6
      normals.set([0, 127, 0, 0], i * 4)
      textures[i] = tileAt(gx, gz) | (2 << 13) // the tiling code bits must be ignored
    }
  }
  return { id, origin, heights, normals, textures, blocks: blocks() }
}

/** Every plant of every chunk: [kind, x, y, z]. */
function allPlants(src: ScatterSource, fraction = 1, occupied?: (x: number, z: number, y: number) => boolean): number[][] {
  const out: number[][] = []
  for (let c = 0; c < CHUNKS_PER_REGION; c++) {
    const d = scatterChunk(src, c, densityOf, fraction, occupied)
    d.plants.forEach((p, k) => {
      for (let i = 0; i < p.length; i += 5) out.push([k, p[i]!, p[i + 1]!, p[i + 2]!])
    })
  }
  return out
}

/** Tile ids at the four corners of the 2 m cell under glTF (x, z) of a region at `origin`. */
function cornerTiles(src: ScatterSource, x: number, z: number): number[] {
  const gx = Math.floor((x - src.origin[0]) / 2)
  const gz = Math.floor((src.origin[2] - z) / 2)
  return [[gx, gz], [gx + 1, gz], [gx, gz + 1], [gx + 1, gz + 1]].map(([i, j]) => src.textures[j! * GRID + i!]! & 0x3ff)
}

describe('density table (tile2d types)', () => {
  it('is dense on grass, sparse on dirt, none on stone, water and pavement names', () => {
    expect(tileScatterDensity(tile(0, 'Grass', 'x_grass.ddj'))).toBeGreaterThan(0.5)
    expect(tileScatterDensity(tile(0, 'LongGrass', 'x.ddj'))).toBeGreaterThan(0.5)
    expect(tileScatterDensity(tile(0, 'Forest', 'x.ddj'))).toBeGreaterThan(0.5)
    const dirt = tileScatterDensity(tile(0, 'Dirt', 'c_dust_fld_01.ddj'))
    expect(dirt).toBeGreaterThan(0)
    expect(dirt).toBeLessThan(0.2)
    expect(tileScatterDensity(tile(0, 'Sand', 'x.ddj'))).toBeLessThan(0.2)
    for (const t of ['Stone', 'Water', 'DeepWater', 'Metal', 'Wood', 'Snow']) expect(tileScatterDensity(tile(0, t, 'x.ddj')), t).toBe(0)
    // Names win over types: the Jangan town marble is typed Dirt, alex_stone02 Grass.
    expect(tileScatterDensity(tile(0, 'Dirt', 'c_marble_jang_08_1.ddj'))).toBe(0)
    expect(tileScatterDensity(tile(0, 'Grass', 'alex_stone02.ddj'))).toBe(0)
    // Grassy dirt lies between.
    expect(tileScatterDensity(tile(0, 'Dirt', 'wc_grass_don_01.ddj'))).toBeGreaterThan(dirt)
    expect(tileScatterDensity(tile(0, null, 'x.ddj'))).toBe(0)
  })
})

describe('scatterChunk (placement)', () => {
  it('is deterministic per region seed and chunk', () => {
    const a = makeSource()
    const b = makeSource()
    for (let c = 0; c < CHUNKS_PER_REGION; c++) {
      const p = scatterChunk(a, c, densityOf, 0.6)
      const q = scatterChunk(b, c, densityOf, 0.6)
      expect(q.count).toBe(p.count)
      q.plants.forEach((list, k) => expect(Array.from(list)).toEqual(Array.from(p.plants[k]!)))
    }
    expect(chunkSeed(1, 0)).toBe(chunkSeed(1, 0))
    expect(chunkSeed(1, 0)).not.toBe(chunkSeed(2, 0))
    expect(chunkSeed(1, 0)).not.toBe(chunkSeed(1, 1))
    // Another region (same terrain) grows different plants.
    const other = scatterChunk(makeSource((97 << 8) | 169), 0, densityOf, 0.6)
    expect(Array.from(other.plants[0]!)).not.toEqual(Array.from(scatterChunk(a, 0, densityOf, 0.6).plants[0]!))
  })

  it('never places on stone, road or water tiles, and keeps plain dirt bare except next to grass', () => {
    const src = makeSource()
    const plants = allPlants(src)
    expect(plants.length).toBeGreaterThan(3000)
    let fringe = 0
    for (const [, x, , z] of plants) {
      const corners = cornerTiles(src, x!, z!)
      for (const t of corners) expect([2, 4, 5]).not.toContain(t)
      expect(corners.some(t => t === 1)).toBe(true)
      if (corners.includes(3)) fringe++
    }
    expect(fringe).toBeGreaterThan(0) // dirt cells touching grass get a few
    // Inside the rectangles: nothing on the road strip (x 80..88 m), the water (x > 160, z < -96) or deep in the dirt.
    for (const [, x, , z] of plants) {
      expect(x! >= 78 && x! <= 88).toBe(false)
      expect(x! > 160 && -z! > 96).toBe(false)
      expect(x! > 92 && x! < 170 && -z! < 90).toBe(false)
    }
  })

  it('sits plants on the terrain, inside their chunk, with the kind height ranges', () => {
    const src = makeSource()
    for (let c = 0; c < CHUNKS_PER_REGION; c++) {
      const d = scatterChunk(src, c, densityOf, 1)
      d.plants.forEach((p, k) => {
        const [h0, h1] = SCATTER_KINDS[k]!.heightM
        for (let i = 0; i < p.length; i += 5) {
          const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
          expect(x).toBeGreaterThanOrEqual(d.minX)
          expect(x).toBeLessThanOrEqual(d.maxX)
          expect(z).toBeGreaterThanOrEqual(d.minZ)
          expect(z).toBeLessThanOrEqual(d.maxZ)
          expect(y).toBeCloseTo(terrainHeightAt(src.heights, (x - src.origin[0]) * 10, (src.origin[2] - z) * 10), 4)
          expect(p[i + 4]).toBeGreaterThanOrEqual(h0)
          expect(p[i + 4]).toBeLessThanOrEqual(h1)
        }
      })
    }
  })

  it('skips points under a water plane, covered by an object floor, or on steep ground', () => {
    const src = makeSource()
    src.blocks[0] = { ...src.blocks[0]!, water: { kind: 'water', type: 0, wave: 0, heightM: 50 } }
    // Occupied: an object floor over x < 20 m.
    const plants = allPlants(src, 1, x => x < 20)
    for (const [, x, , z] of plants) {
      expect(x! < 32 && -z! < 32).toBe(false) // block (0, 0) is under water
      expect(x! < 20).toBe(false)
    }
    // Steep: tilt the normals of the north-west quarter.
    const steep = makeSource()
    for (let gz = 48; gz < GRID; gz++) for (let gx = 0; gx < 40; gx++) steep.normals && (steep.normals as Int8Array).set([90, 80, 0, 0], (gz * GRID + gx) * 4)
    for (const [, x, , z] of allPlants(steep)) expect(x! < 78 && -z! > 98).toBe(false)
  })

  it('scales with the level fraction (off draws nothing)', () => {
    const src = makeSource()
    const count = (f: number) => allPlants(src, f).length
    const low = count(SCATTER_PRESETS.low.fraction)
    const medium = count(SCATTER_PRESETS.medium.fraction)
    const high = count(SCATTER_PRESETS.high.fraction)
    expect(count(SCATTER_PRESETS.off.fraction)).toBe(0)
    expect(low).toBeGreaterThan(0)
    expect(medium).toBeGreaterThan(low * 1.3)
    expect(high).toBeGreaterThan(medium * 1.3)
    // Low grows grass and weeds only (two draw calls per chunk); medium adds bushes and flowers.
    const kindsAt = (f: number) => new Set(allPlants(src, f).map(p => p[0]))
    expect([...kindsAt(SCATTER_PRESETS.low.fraction)].sort()).toEqual([0, 1])
    expect([...kindsAt(SCATTER_PRESETS.medium.fraction)].sort()).toEqual([0, 1, 2, 3, 4])
  })
})

// ---- the renderer -------------------------------------------------------------------------------------------------

function regionData(src: ScatterSource): RegionData {
  const region = { id: src.id, x: src.id & 0xff, z: src.id >> 8, origin: src.origin, blocks: src.blocks } as unknown as WorldRegion
  return { region, terrain: { heights: src.heights, normals: src.normals, textures: src.textures } as unknown as RegionData['terrain'], navmesh: null }
}

function makeScatter(level: 'low' | 'medium' | 'high' = 'medium') {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  let clock = 0
  const scatter = new WorldScatter({
    scene,
    assets: new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) }),
    manifest: { tiles: TILES, models: [] },
  }, { level, retail: false, now: () => clock })
  cleanups.push(() => {
    scatter.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, scatter, tick: (ms: number) => { clock += ms } }
}

describe('WorldScatter (NullEngine)', () => {
  it('grows chunks around the camera one per frame, as thin instances, and drops them far away', async () => {
    const { scene, scatter } = makeScatter('medium')
    const src = makeSource()
    scatter.addRegion(regionData(src))
    const cam = { x: 20, y: 15, z: -20 }
    scatter.update(cam) // starts loading the kinds
    await scatter.ready()
    expect(scatter.stats.art).toContain('procedural')
    scatter.update(cam)
    expect(scatter.stats.chunks).toBe(1)
    for (let i = 0; i < 40; i++) scatter.update(cam)
    // Within 60 + 12 m of (20, -20): chunk columns 0..1 and rows 0..1 of the 48 m grid (4 chunks).
    expect(scatter.stats.chunks).toBe(4)
    const meshes = scatter.meshes()
    expect(meshes.length).toBe(scatter.stats.meshes)
    const instances = meshes.reduce((s, m) => s + m.thinInstanceCount, 0)
    expect(instances).toBe(scatter.stats.plants)
    expect(instances).toBeGreaterThan(500)
    for (const m of meshes) {
      expect(m.isPickable).toBe(false)
      expect(scene.meshes).toContain(m)
    }
    // The same chunk regrows identically.
    const first = scatter.chunksOf(src.id).map(c => c.count)
    // Walk far away: every chunk is dropped.
    scatter.update({ x: 2000, y: 15, z: -2000 })
    expect(scatter.stats.chunks).toBe(0)
    expect(scatter.meshes()).toHaveLength(0)
    for (const m of meshes) expect(m.isDisposed()).toBe(true)
    for (let i = 0; i < 40; i++) scatter.update(cam)
    expect(scatter.chunksOf(src.id).map(c => c.count).sort()).toEqual(first.sort())
  })

  it('a level change regrows at the new density; off removes everything', async () => {
    const { scatter } = makeScatter('low')
    scatter.addRegion(regionData(makeSource()))
    const cam = { x: 20, y: 15, z: -20 }
    await scatter.ready()
    for (let i = 0; i < 40; i++) scatter.update(cam)
    const low = scatter.stats.plants
    scatter.setLevel('high')
    expect(scatter.stats.chunks).toBe(0)
    for (let i = 0; i < 40; i++) scatter.update(cam)
    expect(scatter.stats.plants).toBeGreaterThan(low * 1.5)
    scatter.setLevel('off')
    expect(scatter.stats.chunks).toBe(0)
    expect(scatter.meshes()).toHaveLength(0)
    for (let i = 0; i < 5; i++) scatter.update(cam)
    expect(scatter.stats.chunks).toBe(0)
  })

  it('disposes a region with its chunks and materials', async () => {
    const { scene, scatter } = makeScatter()
    const src = makeSource()
    const baseMeshes = scene.meshes.length
    const baseMaterials = scene.materials.length
    scatter.addRegion(regionData(src))
    await scatter.ready()
    for (let i = 0; i < 40; i++) scatter.update({ x: 96, y: 15, z: -96 })
    expect(scatter.stats.chunks).toBeGreaterThan(8)
    expect(scene.meshes.length).toBeGreaterThan(baseMeshes)
    expect(scatter.removeRegion(src.id)).toBe(true)
    expect(scatter.hasRegion(src.id)).toBe(false)
    expect(scatter.stats).toMatchObject({ regions: 0, chunks: 0, meshes: 0, plants: 0 })
    expect(scene.meshes.length).toBe(baseMeshes)
    // (Babylon's lazily created scene default material is not ours.)
    expect(scene.materials.filter(m => m !== scene.defaultMaterial).length).toBe(baseMaterials)
    // Adding it again replaces cleanly.
    scatter.addRegion(regionData(src))
    scatter.addRegion(regionData(src))
    expect(scatter.stats.regions).toBe(1)
  })
})

function fakeTexture(): BaseTexture {
  return { dispose() {}, getInternalTexture: () => null } as unknown as BaseTexture
}

describe('scatter with RegionStreamer (synthetic 7 x 7 world)', () => {
  it('registers each region as it becomes ready and disposes it with the region', async () => {
    const fx = makeFixture()
    // The fixture's terrain words are tile 0: make it grass.
    fx.manifest.tiles.push({ id: 0, source: 'c_grass_fld_03.ddj', file: 'tiles/0.png', width: 4, height: 4, typeName: 'Grass', category: '' })
    const { engine, scene, world, chunks } = await makeWorld(fx)
    const models = fakeModels(scene)
    const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
      now: () => 0, autoPump: false, nav: chunks, loadModel: models.loadModel, disposeModel: models.disposeModel,
      atlas: { create: () => fakeTexture(), upload: () => true },
    })
    world.stream = stream
    stream.booting = false
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })
    const run = async (focus: { x: number; z: number }) => {
      for (let i = 0; i < 400; i++) {
        stream.update(focus, null)
        await settle(2)
        if (!stream.stats.jobs && !stream.stats.fetching && stream.stats.ready === stream.stats.resident) return
      }
    }
    const c = centre(CX, CZ)
    await run(c)
    expect(stream.stats.ready).toBe(21)
    for (const r of world.regions.regions) expect(world.scatter.hasRegion(r.region.id), `${r.region.x},${r.region.z}`).toBe(true)
    expect(world.scatter.stats.regions).toBe(21)
    await world.scatter.ready()
    for (let i = 0; i < 30; i++) world.scatter.update({ x: c.x, y: 20, z: c.z })
    const centreId = (CZ << 8) | CX
    expect(world.scatter.chunksOf(centreId).length).toBeGreaterThan(0)
    const meshes = world.scatter.meshes()
    expect(meshes.length).toBeGreaterThan(0)
    // Far west: the centre column unloads, and its scatter goes with it.
    const eastId = (CZ << 8) | (CX + 2)
    await run(centre(CX - 3, CZ))
    expect(stream.state(CX + 2, CZ)).toBe('absent')
    expect(world.scatter.hasRegion(eastId)).toBe(false)
    expect(world.scatter.stats.regions).toBe(stream.stats.resident)
    for (const r of world.regions.regions) expect(world.scatter.hasRegion(r.region.id)).toBe(true)
  })
})
