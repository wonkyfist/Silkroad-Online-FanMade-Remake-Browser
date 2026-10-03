/**
 * Object seams (docs/WAVE_PLAN3.md §4.1): WorldObjects.addRegionListener (placed per region with the model info and
 * meshes, removed per region, replay for a late listener, a remover), setAnimationSpeed's 2 s ramp,
 * ObjectMaterials.addDecorator (every converted material, with its model, class-relevant flags and retail texture) and
 * isFoliageModel. Synthetic 7 x 7 world, fake clock and fake models.
 */
import type { BaseTexture } from '@babylonjs/core'
import { AssetContainer, NullEngine, PBRMaterial, Scene, StandardMaterial } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Assets,
  ObjectMaterials,
  RegionStreamer,
  STREAM_DEFAULTS,
  isFoliageModel,
  type MaterialDecoratorInfo,
  type PlacedModelInfo,
  type RegionListener,
} from '../src/index.ts'
import { CX, CZ, X0, fakeModels, makeFixture, makeWorld, settle } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const centre = (x: number, z: number) => ({ x: 192 * (x - CX) + 96, z: -192 * (z - CZ) - 96 })

async function setup() {
  const fx = makeFixture()
  const { engine, scene, world, chunks } = await makeWorld(fx)
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0,
    autoPump: false,
    objects: true,
    nav: chunks,
    loadModel: models.loadModel,
    disposeModel: models.disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  const run = async (focus: { x: number; z: number }, frames = 600) => {
    for (let i = 0; i < frames; i++) {
      stream.update(focus, null)
      await settle(2)
      if (!stream.stats.jobs && !stream.stats.fetching && stream.stats.ready + stream.stats.failed === stream.stats.resident &&
        stream.stats.objectsReady === stream.stats.ready) {
        stream.update(focus, null)
        if (!stream.stats.jobs) return
      }
    }
  }
  return { scene, world, stream, run }
}

/** A listener that records every call. */
function recorder() {
  const placed: Array<{ region: number; info: PlacedModelInfo; meshes: number; placements: number }> = []
  const removed: number[] = []
  const l: RegionListener = {
    placed: (region, _model, info, meshes, placements) => placed.push({ region, info, meshes: meshes.length, placements: placements.length }),
    removed: region => removed.push(region),
  }
  return { l, placed, removed }
}

describe('WorldObjects.addRegionListener', () => {
  it('is told about every placement batch per region, and every region removal', async () => {
    const { world, stream, run } = await setup()
    const r = recorder()
    world.objects.addRegionListener(r.l)
    await run(centre(CX, CZ))
    // One static batch (model 0) per region, plus the centre region's skinned clone (model 1).
    const statics = r.placed.filter(p => p.info.index === 0)
    const clones = r.placed.filter(p => p.info.index === 1)
    expect(statics).toHaveLength(21)
    expect(new Set(statics.map(p => p.region)).size).toBe(21)
    expect(clones).toHaveLength(1)
    expect(clones[0]!.info.kind).toBe('clone')
    expect(clones[0]!.region).toBe(stream.chunk(CX, CZ)!.owner)
    for (const p of r.placed) {
      expect(p.meshes, 'the batch meshes').toBeGreaterThan(0)
      expect(p.placements).toBe(1)
      expect(p.info.heightM).toBe(2) // boundsMax.y − boundsMin.y of the fixture models
      expect(p.info.isFoliage).toBe(false)
    }
    expect(statics[0]!.info).toMatchObject({ index: 0, source: 'm0.bsr', kind: 'static' })
    expect(r.removed).toEqual([])

    const owners = new Map([...Array(7).keys()].map(i => [X0 + i, stream.chunk(X0 + i, CZ)?.owner]))
    await run(centre(X0, CZ))
    expect(stream.state(CX + 2, CZ)).toBe('absent')
    expect(r.removed).toContain(owners.get(CX + 2))
    expect(new Set(r.removed).size).toBe(r.removed.length) // once per region
  })

  it('replays the placements so far to a late listener; the remover stops it', async () => {
    const { world, run } = await setup()
    await run(centre(CX, CZ))
    const r = recorder()
    const remove = world.objects.addRegionListener(r.l)
    expect(r.placed).toHaveLength(22)
    remove()
    await run(centre(X0, CZ))
    expect(r.removed).toEqual([])
    expect(r.placed).toHaveLength(22)
  })

  it('a listener that throws does not stop the others', async () => {
    const { world, run } = await setup()
    const warn = console.warn
    console.warn = () => {}
    cleanups.push(() => (console.warn = warn))
    world.objects.addRegionListener({ placed: () => { throw new Error('boom') }, removed: () => { throw new Error('boom') } })
    const r = recorder()
    world.objects.addRegionListener(r.l)
    await run(centre(CX, CZ))
    expect(r.placed).toHaveLength(22)
  })
})

describe('WorldObjects.setAnimationSpeed', () => {
  it('ramps the clone animation speed over 2 s and holds it', async () => {
    const { world } = await setup()
    const o = world.objects
    expect(o.animationSpeed).toBe(1)
    o.setAnimationSpeed(2, 1000)
    o.tickAnimationSpeed(1000)
    expect(o.animationSpeed).toBe(1)
    o.tickAnimationSpeed(2000)
    expect(o.animationSpeed).toBeCloseTo(1.5, 12)
    o.tickAnimationSpeed(3000)
    expect(o.animationSpeed).toBe(2)
    // A new target mid-ramp starts from the current speed; bad values mean 1.
    o.setAnimationSpeed(0.5, 3000)
    o.tickAnimationSpeed(4000)
    expect(o.animationSpeed).toBeCloseTo(1.25, 12)
    o.setAnimationSpeed(Number.NaN, 4000)
    o.tickAnimationSpeed(6000)
    expect(o.animationSpeed).toBe(1)
  })
})

describe('ObjectMaterials.addDecorator', () => {
  it('runs on every material convert() creates, with the model info, flags and retail texture', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const mats = new ObjectMaterials(scene, new Assets('http://mem.test/', { bytes: async () => new Uint8Array() as Uint8Array<ArrayBuffer>, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) }))
    expect(mats.mode).toBe('classic')
    const container = new AssetContainer(scene)
    const a = new PBRMaterial('lamp', scene)
    const b = new PBRMaterial('leaf', scene)
    b.transparencyMode = PBRMaterial.MATERIAL_ALPHATEST
    container.materials.push(a, b)
    const seen: Array<[string, MaterialDecoratorInfo]> = []
    const remove = mats.addDecorator((m, info) => {
      expect(m).toBeInstanceOf(StandardMaterial)
      seen.push([m.name, info])
    })
    await mats.convert(container, {
      materials: [
        { name: 'lamp', flags: 0x8, diffuse: [1, 1, 1, 1], ambient: [1, 1, 1, 1], texture: 'prim\\mtrl\\Lamp.ddj', alphaMode: 'OPAQUE' },
      ],
    } as never, false, { model: 'models/lamp.glb', source: 'res\\bldg\\lamp.bsr', kind: 'clone' })
    expect(seen.map(s => s[0])).toEqual(['lamp', 'leaf'])
    expect(seen[0]![1]).toEqual({ model: 'models/lamp.glb', source: 'res\\bldg\\lamp.bsr', kind: 'clone', unlit: true, alpha: 'opaque', texture: 'prim\\mtrl\\Lamp.ddj' })
    expect(seen[1]![1]).toEqual({ model: 'models/lamp.glb', source: 'res\\bldg\\lamp.bsr', kind: 'clone', unlit: false, alpha: 'mask' })
    remove()
    const c2 = new AssetContainer(scene)
    c2.materials.push(new PBRMaterial('x', scene))
    await mats.convert(c2, null, false)
    expect(seen).toHaveLength(2)
  })
})

describe('isFoliageModel (WEATHER §6.4, the tree\\d* fix)', () => {
  it('matches trees, grass, flowers and reeds under nature/common and nature/china/<region>', () => {
    expect(isFoliageModel('res\\nature\\china\\jangan\\tree\\tree_01.bsr')).toBe(true)
    expect(isFoliageModel('res/nature/china/dunhuang/tree2/t.bsr')).toBe(true)
    expect(isFoliageModel('res\\nature\\common\\grass\\grs_weed07.bsr')).toBe(true)
    expect(isFoliageModel('RES\\NATURE\\COMMON\\FLOWER\\f.bsr')).toBe(true)
    expect(isFoliageModel('res\\nature\\china\\jangan\\rock\\r.bsr')).toBe(false)
    expect(isFoliageModel('res\\bldg\\china\\jangan\\tree_house.bsr')).toBe(false)
  })
})
