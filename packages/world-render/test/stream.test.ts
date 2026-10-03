/**
 * Region streaming (docs/FIELDS.md §7 lane 2) on a synthetic 7 x 7 world of flat regions (NullEngine, fake assets):
 * the wanted set, hysteresis, view-biased order, the frame budget, the model cache's grace time, the tile atlas,
 * navCovers and the client nav across streamed regions. The streamer is built with a fake clock and no timer pump,
 * so every job runs from an explicit update()/pump().
 */
import type { BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ModelCache,
  RegionStreamer,
  STREAM_DEFAULTS,
  TileAtlas,
  loadWorld,
  rectDistance,
  regionInfos,
  type RegionEvent,
  type StreamSettings,
  type World,
} from '../src/index.ts'
import { CX, CZ, N, ROOT_URL, WORLD_NAME, X0, Z0, fakeModels, heightOf, makeFixture, makeWorld, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Centre of region (x, z) in glTF metres (origin region = the centre one). */
const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })

async function setup(settings: Partial<StreamSettings> = {}, objects = true, failOnce: string | null = null) {
  const fx = makeFixture()
  if (failOnce) {
    const bytes = fx.io.bytes.bind(fx.io)
    let failed = false
    fx.io.bytes = async (url, signal) => {
      if (!failed && url.endsWith(failOnce)) {
        failed = true
        throw new Error('HTTP 503')
      }
      return bytes(url, signal)
    }
  }
  const { engine, scene, world, chunks } = await makeWorld(fx)
  let clock = 0
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium, ...settings }, {
    now: () => clock,
    autoPump: false,
    objects,
    nav: chunks,
    loadModel: models.loadModel,
    disposeModel: models.disposeModel,
    atlas: { create: () => fakeTexture(), upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  const events: Array<[number, number, RegionEvent]> = []
  stream.onRegion = (x, z, e) => events.push([x, z, e])
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  /** Updates until nothing is queued or fetching (at most `frames` frames). */
  const run = async (focus: { x: number; z: number }, forward: { x: number; z: number } | null = null, frames = 400) => {
    for (let i = 0; i < frames; i++) {
      stream.update(focus, forward)
      await settle(2)
      if (!stream.stats.jobs && !stream.stats.fetching && stream.stats.ready + stream.stats.failed === stream.stats.resident &&
        stream.stats.objectsReady === stream.stats.ready) {
        stream.update(focus, forward)
        if (!stream.stats.jobs) return i
      }
    }
    return frames
  }
  return { fx, world, stream, models, events, run, tick: (ms: number) => { clock += ms }, now: () => clock, setClock: (t: number) => { clock = t } }
}

function fakeTexture(): BaseTexture {
  return { dispose() {}, getInternalTexture: () => null } as unknown as BaseTexture
}

describe('RegionStreamer (synthetic 7 x 7 world)', () => {
  it('wants the 21 regions within 400 m of a region centre (5 x 5 minus the corners)', async () => {
    const { stream, run, world } = await setup()
    await run(centre(CX, CZ))
    expect(stream.stats.wanted).toBe(21)
    expect(stream.stats.ready).toBe(21)
    expect(stream.stats.objectsReady).toBe(21)
    expect(stream.state(CX + 2, CZ + 2)).toBe('absent') // a corner: 407 m away
    expect(stream.state(CX + 2, CZ + 1)).toBe('ready')
    expect(world.terrain.regionCount).toBe(21)
    expect(world.regions.regions).toHaveLength(21)
    // One static chunk per region (model 0) and the centre region's skinned clone (model 1).
    expect(world.objects.regionCount()).toBe(21)
    expect(world.objects.stats.clones).toBe(1)
    expect(stream.stats.modelsLoaded).toBe(2)
  })

  it('never unloads while the focus oscillates +-100 m across a border', async () => {
    const { stream, run } = await setup()
    const c = centre(CX, CZ)
    await run(c)
    const border = c.x + 96
    for (let i = 0; i < 12; i++) await run({ x: border + (i % 2 ? 100 : -100), z: c.z }, null, 50)
    expect(stream.stats.unloads).toBe(0)
  })

  it('unloads past the unload radius and releases its terrain, nav, objects and tiles', async () => {
    const { stream, run, world } = await setup()
    await run(centre(CX, CZ))
    const west = centre(X0, CZ)
    // The focus in the westmost column: column CX + 2 (east) is > 560 m away.
    await run(west)
    expect(stream.state(CX + 2, CZ)).toBe('absent')
    expect(stream.stats.unloads).toBeGreaterThan(0)
    expect(world.terrain.regionCount).toBe(stream.stats.ready)
    expect(world.regions.get(((CZ) << 8) | (CX + 2))).toBeNull()
    // Nav terrain of the unloaded region is gone: a point there is unloaded terrain.
    const p = centre(CX + 2, CZ)
    expect(Number.isNaN(world.nav.world.terrainHeight((CX + 2) * 1920 + 960, CZ * 1920 + 960))).toBe(true)
    expect(world.heightAt(p.x, p.z)).toBeNull()
    // Resident regions still answer with their own height.
    const q = centre(X0, CZ)
    expect(world.heightAt(q.x, q.z)).toBeCloseTo(heightOf(X0, CZ), 5)
  })

  it('orders regions at equal distance by the view direction', async () => {
    const { stream, events, run } = await setup({ maxFetches: 1 })
    await run(centre(CX, CZ), { x: 1, z: 0 })
    const ready = events.filter(e => e[2] === 'ready').map(e => `${e[0]},${e[1]}`)
    expect(ready[0]).toBe(`${CX},${CZ}`)
    // East (in view) before north, south and west at the same 96 m.
    expect(ready[1]).toBe(`${CX + 1},${CZ}`)
    expect(ready.indexOf(`${CX + 1},${CZ}`)).toBeLessThan(ready.indexOf(`${CX - 1},${CZ}`))
    const east = stream.chunk(CX + 1, CZ)!
    const west = stream.chunk(CX - 1, CZ)!
    expect(east.distance).toBeCloseTo(west.distance, 6)
    expect(east.priority).toBeLessThan(west.priority)
  })

  it('stops committing at the frame budget, but runs at least one job per frame', async () => {
    const { stream, world, tick } = await setup({ frameBudgetMs: 4 }, false)
    // Every core commit job costs 5 ms of the fake clock.
    const t = world.terrain, w = world.water, n = world.nav.world
    const b = t.buildRegion.bind(t), a = w.addRegion.bind(w), r = n.addRegion.bind(n)
    t.buildRegion = (...args) => (tick(5), b(...args))
    w.addRegion = (...args) => (tick(5), a(...args))
    n.addRegion = (...args) => (tick(5), r(...args))
    const c = centre(CX, CZ)
    stream.update(c, null) // wanted set; fetches start
    await settle(10)
    stream.update(c, null) // tile uploads (free); the regions then queue their commit jobs
    await settle(10)
    stream.update(c, null)
    const before = stream.stats.jobs
    expect(before).toBeGreaterThan(10)
    stream.update(c, null)
    expect(stream.stats.jobs).toBe(before - 1)
    expect(stream.stats.lastFrameMs).toBeGreaterThanOrEqual(5)
    // Cheap jobs (1 ms each): four per 4 ms frame.
    t.buildRegion = (...args) => (tick(1), b(...args))
    w.addRegion = (...args) => (tick(1), a(...args))
    n.addRegion = (...args) => (tick(1), r(...args))
    const mid = stream.stats.jobs
    stream.update(c, null)
    expect(stream.stats.jobs).toBe(mid - 4)
  })

  it('disposes a model only after its last region unloads and the grace time has passed', async () => {
    const { stream, run, models, tick, world } = await setup({ modelGraceS: 30 })
    await run(centre(CX, CZ))
    expect(models.loads.sort()).toEqual([0, 1])
    expect(stream.models.refs(1)).toBe(1)
    // Far east: the centre region (the only one drawing model 1) unloads; model 0 is still used by the east regions.
    const east = { x: 192 * 3 + 190, z: -96 }
    expect(rectDistance(east.x, east.z, { minX: 0, maxX: 192, minZ: -192, maxZ: 0 })).toBeGreaterThan(560)
    await run(east)
    expect(stream.state(CX, CZ)).toBe('absent')
    expect(stream.models.refs(1)).toBe(0)
    expect(models.disposed).toEqual([])
    tick(29_000)
    stream.update(east, null)
    expect(models.disposed).toEqual([])
    expect(stream.stats.modelsCached).toBe(1)
    tick(1_001)
    stream.update(east, null)
    expect(models.disposed).toEqual([1])
    expect(stream.models.isLoaded(0)).toBe(true)
    expect(world.objects.stats.clones).toBe(0)
    // Coming back loads it again.
    await run(centre(CX, CZ))
    expect(models.loads.filter(i => i === 1)).toHaveLength(2)
  })

  it('keeps a released model cached when its region comes back within the grace time', async () => {
    const { stream, run, models, tick } = await setup({ modelGraceS: 30 })
    await run(centre(CX, CZ))
    await run({ x: 192 * 3 + 190, z: -96 })
    tick(10_000)
    await run(centre(CX, CZ))
    tick(60_000)
    stream.update(centre(CX, CZ), null)
    expect(models.disposed).toEqual([])
    expect(models.loads.filter(i => i === 1)).toHaveLength(1)
  })

  it('navCovers is true over ready regions and false across an absent one', async () => {
    const { stream, run } = await setup()
    const c = centre(CX, CZ)
    await run(c)
    expect(stream.navCovers(c.x, c.z, c.x + 150, c.z + 150)).toBe(true)
    const corner = centre(CX + 2, CZ + 2)
    expect(stream.state(CX + 2, CZ + 2)).toBe('absent')
    expect(stream.navCovers(c.x, c.z, corner.x, corner.z)).toBe(false)
    // Outside the export.
    expect(stream.navCovers(c.x, c.z, c.x + 5000, c.z)).toBe(false)
  })

  it('walks the client nav across streamed regions and blocks at an absent one', async () => {
    const { stream, run, world } = await setup()
    const c = centre(CX, CZ)
    await run(c)
    const nav = world.nav
    const start = nav.locate(c.x, c.z, Infinity)!
    expect(start).not.toBeNull()
    expect(start.y).toBeCloseTo(heightOf(CX, CZ), 4)
    // Two regions east: loaded (flat, height steps at the border are walkable in this synthetic world).
    const e2 = centre(CX + 2, CZ)
    expect(nav.locate(e2.x, e2.z, Infinity)?.y).toBeCloseTo(heightOf(CX + 2, CZ), 4)
    // Towards the absent corner: blocked at the border of the loaded set.
    const corner = centre(CX + 2, CZ + 2)
    expect(stream.state(CX + 2, CZ + 2)).toBe('absent')
    const r = nav.moveStraight(nav.locate(centre(CX + 2, CZ + 1).x, centre(CX + 2, CZ + 1).z, Infinity)!, corner.x, corner.z)
    expect(r.blocked).toBe(true)
    expect(r.end.z).toBeGreaterThan(corner.z + 90)
  })

  it('a region unloaded and wanted again at once keeps its new objects and model references', async () => {
    const { stream, run, world, models } = await setup({ modelGraceS: 0, modelCacheMax: 0 })
    const c = centre(CX, CZ)
    await run(c)
    // Jump to the far corner and straight back before any unload job has run.
    const far = centre(X0, Z0)
    stream.setFocus(far.x, far.z)
    expect(stream.state(CX, CZ)).toBe('absent')
    stream.setFocus(c.x, c.z)
    await run(c)
    expect(stream.state(CX, CZ)).toBe('ready')
    expect(stream.models.refs(1)).toBe(1)
    expect(stream.models.isLoaded(1)).toBe(true)
    expect(world.objects.stats.clones).toBe(1)
    // The jump started regions that stay resident (hysteresis): everything resident is drawn, once.
    expect(stream.stats.ready).toBe(stream.stats.resident)
    expect(world.objects.regionCount()).toBe(stream.stats.ready)
    expect(world.terrain.regionCount).toBe(stream.stats.ready)
    expect(world.heightAt(c.x, c.z)).toBeCloseTo(heightOf(CX, CZ), 5)
    // Nothing still in use was disposed (a disposed model would be loaded again).
    for (const i of models.disposed) expect(stream.models.refs(i)).toBe(0)
  })

  it('fetches a failed region again after a delay', async () => {
    const { stream, run, tick, world } = await setup({}, true, `terrain/${CX}_${CZ}.bin`)
    const c = centre(CX, CZ)
    await run(c)
    expect(stream.state(CX, CZ)).toBe('failed')
    expect(stream.stats.failed).toBe(1)
    expect(stream.stats.ready).toBe(20)
    expect(world.heightAt(c.x, c.z)).toBeNull()
    tick(5001)
    await run(c)
    expect(stream.state(CX, CZ)).toBe('ready')
    expect(world.heightAt(c.x, c.z)).toBeCloseTo(heightOf(CX, CZ), 5)
    expect(world.objects.stats.clones).toBe(1)
  })

  it('setSettings changes the radii at once (decision 50)', async () => {
    const { stream, run } = await setup()
    const c = centre(CX, CZ)
    await run(c)
    expect(stream.stats.wanted).toBe(21)
    stream.setSettings(STREAM_DEFAULTS.low)
    stream.update(c, null)
    expect(stream.stats.wanted).toBe(21) // 320 m still reaches the (2, 1) ring at 304 m from a region centre
    expect(stream.stats.unloads).toBe(0)
    stream.setSettings({ loadRadiusM: 120, unloadRadiusM: 460 })
    expect(stream.stats.wanted).toBe(5) // the region and its 4 neighbours (96 m); diagonals are 136 m away
    expect(stream.stats.unloads).toBe(0) // hysteresis: nothing is released within 460 m
    stream.setSettings({ loadRadiusM: 100, unloadRadiusM: 150 })
    await run(c)
    expect(stream.stats.resident).toBe(9)
    stream.setSettings({ unloadRadiusM: 120 })
    await run(c)
    expect(stream.stats.resident).toBe(5)
    expect(stream.settings.loadRadiusM).toBe(100)
  })

  it('assigns every placement to its region', async () => {
    const fx = makeFixture()
    const infos = regionInfos({ manifest: fx.manifest })
    expect(infos).toHaveLength(N * N)
    const centreInfo = infos.find(i => i.x === CX && i.z === CZ)!
    expect([...centreInfo.models.keys()].sort()).toEqual([0, 1])
    expect(infos.reduce((n, i) => n + i.placements, 0)).toBe(fx.manifest.placements.length)
  })
})

describe('loadWorld streaming path (synthetic world)', () => {
  it('streams when the manifest has a stream block and resolves once the focus area is ready', async () => {
    const fx = makeFixture()
    const { NullEngine, Scene } = await import('@babylonjs/core')
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const stages: string[] = []
    let last = 0
    let monotonic = true
    const world: World = await loadWorld(scene, {
      baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false,
      onProgress: p => {
        if (stages.at(-1) !== p.stage) stages.push(p.stage)
        if (p.fraction + 1e-9 < last) monotonic = false
        last = p.fraction
      },
    })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    expect(world.stream).not.toBeNull()
    expect(world.navSource).toBe('stream')
    expect(stages[0]).toBe('manifest')
    expect(stages).toContain('regions')
    expect(stages.at(-1)).toBe('done')
    expect(stages.indexOf('navigation')).toBeLessThan(stages.indexOf('regions'))
    expect(monotonic).toBe(true)
    expect(last).toBe(1)
    // Everything within 200 m of the spawn (the centre region's centre) is in: the 3 x 3 block.
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) expect(world.stream!.state(CX + dx, CZ + dz)).toBe('ready')
    expect(world.spawn.y).toBeCloseTo(heightOf(CX, CZ), 4)
    expect(world.heightAt(96, -96)).toBeCloseTo(heightOf(CX, CZ), 4)
    expect(fx.fetched.some(u => u.endsWith('nav-objects.bin'))).toBe(true)
    expect(fx.fetched.some(u => u.endsWith('/nav.bin'))).toBe(false)
  })

  it('keeps the whole-world path when streaming is off', async () => {
    const fx = makeFixture()
    // The synthetic manifest has no nav file: the old path uses the terrain-only fallback.
    const { NullEngine, Scene } = await import('@babylonjs/core')
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    expect(world.stream).toBeNull()
    expect(world.terrain.meshes).toHaveLength(N * N)
  })
})

describe('ModelCache', () => {
  it('shares one load, counts owners and evicts the oldest beyond max', async () => {
    let now = 0
    const disposed: number[] = []
    let loads = 0
    const cache = new ModelCache<string>({
      load: async i => (loads++, `m${i}`), dispose: (_v, i) => disposed.push(i), graceS: 100, max: 1, now: () => now,
    })
    const [a, b] = await Promise.all([cache.acquire(1, 10), cache.acquire(1, 11)])
    expect(a).toBe('m1')
    expect(b).toBe('m1')
    expect(loads).toBe(1)
    expect(cache.refs(1)).toBe(2)
    await cache.acquire(2, 10)
    await cache.acquire(3, 10)
    cache.release(1, 10)
    cache.update()
    expect(disposed).toEqual([]) // still owned by 11
    cache.release(1, 11)
    now = 1
    cache.release(2, 10)
    now = 2
    cache.release(3, 10)
    cache.update()
    expect(disposed).toEqual([1, 2]) // max 1 idle entry: the two oldest go
    expect(cache.stats).toMatchObject({ loaded: 1, cached: 1 })
    now = 100_002
    cache.update()
    expect(disposed).toEqual([1, 2, 3])
  })

  it('remembers a failed load and never retries it', async () => {
    let loads = 0
    const cache = new ModelCache<string>({ load: async () => { loads++; throw new Error('bad glb') }, dispose: () => {}, graceS: 1, max: 1 })
    await expect(cache.acquire(5, 1)).rejects.toThrow('bad glb')
    await expect(cache.acquire(5, 2)).rejects.toThrow('bad glb')
    expect(loads).toBe(1)
    expect(cache.stats.failed).toBe(1)
  })
})

describe('TileAtlas', () => {
  function atlas(layers: number) {
    const uploads: Array<[BaseTexture, number, number]> = []
    const textures: BaseTexture[] = []
    const decoded: number[] = []
    const onTexture: BaseTexture[] = []
    const a = new TileAtlas({
      scene: null as never,
      size: 4,
      layers,
      growBy: 2,
      decode: async id => {
        decoded.push(id)
        return new Uint8Array(4 * 4 * 4).fill(id)
      },
      create: () => {
        const t = fakeTexture()
        textures.push(t)
        return t
      },
      upload: (tex, layer, rgba) => {
        uploads.push([tex, layer, rgba[0]!])
        return true
      },
      onTexture: t => onTexture.push(t),
    })
    return { a, uploads, textures, decoded, onTexture }
  }

  it('reuses a layer only once its tile has no reference left', async () => {
    const { a } = atlas(4)
    await a.acquire([1, 2, 3, 4], () => 0)
    const layers = [1, 2, 3, 4].map(id => a.layerOf(id)!)
    expect(new Set(layers).size).toBe(4)
    a.release([2])
    await a.acquire([5], () => 0)
    expect(a.layerOf(5)).toBe(layers[1]) // tile 2's layer (refcount 0)
    expect(a.layerOf(2)).toBeUndefined()
    for (const id of [1, 3, 4]) expect(a.layerOf(id)).toBe(layers[id - 1]) // live tiles never move
    expect(a.used).toBe(4)
  })

  it('keeps an unreferenced tile resident until its layer is needed', async () => {
    const { a, decoded } = atlas(4)
    await a.acquire([1, 2], () => 0)
    a.release([1])
    await a.acquire([1], () => 0)
    expect(decoded).toEqual([1, 2]) // not decoded again
    expect(a.refs(1)).toBe(1)
  })

  it('grows when every layer is referenced, keeping every tile at its layer', async () => {
    const { a, uploads, textures, onTexture } = atlas(2)
    await a.acquire([1, 2], () => 0)
    const l1 = a.layerOf(1)!
    const l2 = a.layerOf(2)!
    await a.acquire([3], () => 0)
    expect(a.capacity).toBe(4)
    expect(a.rebuilds).toBe(1)
    expect(textures).toHaveLength(2)
    expect(a.texture).toBe(textures[1])
    expect(onTexture.at(-1)).toBe(textures[1])
    expect(a.layerOf(1)).toBe(l1)
    expect(a.layerOf(2)).toBe(l2)
    expect(a.layerOf(3)).toBeGreaterThanOrEqual(2)
    // The new array got tiles 1 and 2 re-uploaded at their layers, and tile 3.
    const inNew = uploads.filter(u => u[0] === textures[1]).map(u => [u[1], u[2]])
    expect(inNew).toEqual(expect.arrayContaining([[l1, 1], [l2, 2], [a.layerOf(3), 3]]))
  })

  it('falls back to whole-array rebuilds when single-layer uploads are refused', async () => {
    const rebuilt: number[][] = []
    const a = new TileAtlas({
      scene: null as never, size: 2, layers: 3,
      decode: async id => new Uint8Array(16).fill(id),
      create: () => fakeTexture(),
      upload: () => false,
      rebuild: layers => (rebuilt.push(layers.map(l => l[0]!)), fakeTexture()),
    })
    await a.acquire([7, 8], () => 0)
    await settle()
    expect(a.fallback).toBe(true)
    expect(rebuilt.length).toBeGreaterThan(0)
    const last = rebuilt.at(-1)!
    expect(last[a.layerOf(7)!]).toBe(7)
    expect(last[a.layerOf(8)!]).toBe(8)
  })
})
