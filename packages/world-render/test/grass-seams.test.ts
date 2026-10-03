/**
 * W10-S, grass and life seams (docs/GRASS_LIFE.md GL-0, §1.3, §8.1, §8.3; docs/WAVE_PLAN6.md §4.1 step 2, D3, D7, D24,
 * D25): the scatter style 'retail' is HEAD; 'field' hands the regions, the level and the frame to a ground cover and
 * drops the retail chunks; `adopt` binds the shared uniforms, later sets, the defines and the depth textures; Low never
 * creates the field; Low and `hideRetailTufts: false` place every tuft model; World.life is made on the PBR path only,
 * updated after the scatter, switched by the wildlife flag and disposed with the world.
 */
import { NullEngine, RawTexture, Scene, ShaderMaterial, Vector4, type RenderTargetTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRID } from '../../convert/src/world/format.ts'
import type { TileTexture, WorldRegion } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  LIFE_TAG,
  QUALITY_PRESETS,
  RETAIL_TUFT_MODELS,
  SCATTER_TAG,
  WorldScatter,
  isRetailTuftModel,
  modelStem,
  type GroundCoverFactory,
  type LifeFactory,
  type RegionData,
  type ScatterOptions,
} from '../src/index.ts'
import { SCATTER_CHUNK_SAMPLERS } from '../src/scatter-assets.ts'
import { FakeField, FakeLife, TUFT_SOURCE, addModel, w10World, type W10Setup } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function world(o: Parameters<typeof w10World>[0] = {}): Promise<W10Setup> {
  const s = await w10World(o)
  cleanups.push(s.dispose)
  return s
}

const TILES: TileTexture[] = [{ id: 1, typeName: 'Grass', source: 'c_grass_fld_03.ddj', file: 'tiles/g.webp', width: 4, height: 4, category: '' }]

/** An all-grass flat region at the origin. */
function grassRegion(id = (97 << 8) | 168): RegionData {
  const n = GRID * GRID
  const normals = new Int8Array(n * 4)
  for (let i = 0; i < n; i++) normals.set([0, 127, 0, 0], i * 4)
  const blocks = Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null }))
  const region = { id, x: id & 0xff, z: id >> 8, origin: [0, 0, 0], blocks } as unknown as WorldRegion
  return { region, terrain: { heights: new Float32Array(n).fill(10), normals, textures: new Uint16Array(n).fill(1) } as unknown as RegionData['terrain'], navmesh: null }
}

function scatter(opts: ScatterOptions = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const s = new WorldScatter({
    scene,
    assets: new Assets('http://mem.test/', { bytes: async () => { throw new Error('no assets') }, decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }) }),
    manifest: { tiles: TILES, models: [] },
  }, { level: 'medium', retail: false, now: () => 0, ...opts })
  cleanups.push(() => {
    s.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, s }
}

/** Grows the chunks around (20, -20) and returns what the retail scatter drew. */
async function grow(s: WorldScatter) {
  const cam = { x: 20, y: 15, z: -20 }
  s.update(cam)
  await s.ready()
  for (let i = 0; i < 40; i++) s.update(cam)
  return { chunks: s.stats.chunks, plants: s.stats.plants, meshes: s.meshes().map(m => `${m.name}×${m.thinInstanceCount}`).sort() }
}

describe("the scatter style: 'retail' is HEAD", () => {
  it("'retail', the default, and a 'field' with no field available all draw the same retail chunks", async () => {
    const a = scatter()
    a.s.addRegion(grassRegion())
    const head = await grow(a.s)
    expect(head.chunks).toBeGreaterThan(0)
    expect(a.s.style).toBe('retail')
    for (const opts of [{ style: 'retail' as const }, { style: 'field' as const, field: null }]) {
      const b = scatter(opts)
      b.s.addRegion(grassRegion())
      expect(await grow(b.s)).toEqual(head)
      expect(b.s.style).toBe('retail')
      expect(b.s.requestedStyle).toBe(opts.style)
      for (const m of b.s.meshes()) expect(m.metadata.sroWorld).toBe(SCATTER_TAG)
    }
  })

  it("'field' hands regions, level and frame to the ground cover and drops the retail chunks; 'retail' brings them back", async () => {
    const made: FakeField[] = []
    const field: GroundCoverFactory = () => {
      const f = new FakeField()
      made.push(f)
      return f
    }
    const { s } = scatter({ field })
    s.addRegion(grassRegion())
    const head = await grow(s)
    s.setStyle('field')
    const f = made[0]!
    expect(s.style).toBe('field')
    expect(s.groundCover).toBe(f)
    expect(s.stats.chunks).toBe(0)
    expect([...f.regions]).toEqual([grassRegion().region.id])
    expect(f.levels).toEqual(['medium'])
    s.update({ x: 20, y: 15, z: -20 })
    expect(f.updates).toBe(1)
    expect(s.stats.chunks).toBe(0)
    s.setLevel('high')
    expect(f.levels.at(-1)).toBe('high')
    s.addRegion(grassRegion(5))
    expect(f.regions.has(5)).toBe(true)
    s.removeRegion(5)
    expect(f.regions.has(5)).toBe(false)
    s.setStyle('retail')
    expect(f.disposed).toBe(true)
    s.setLevel('medium')
    expect(await grow(s)).toEqual(head)
  })
})

describe('WorldScatter.adopt', () => {
  it('binds the shared uniforms (now and later), the defines, the depth textures, the retail by-reference values and the fallbacks', () => {
    const { scene, s } = scatter()
    const before = new Vector4(1, 2, 3, 4)
    s.sharedUniforms.set('wxA', before)
    s.setDefine('SRO_HDR', true)
    const chunkSampler = SCATTER_CHUNK_SAMPLERS[0]
    const mat = new ShaderMaterial('field', scene, 'sroScatter', {
      attributes: ['position'],
      uniforms: ['scCamera', 'scFade', 'wxA', 'wxB'],
      samplers: chunkSampler ? [chunkSampler] : [],
    })
    const off = s.adopt(mat)
    expect(s.adopts(mat)).toBe(true)
    const vec = (name: string) => (mat as unknown as { _vectors4: Record<string, Vector4> })._vectors4[name]
    const tex = (name: string) => (mat as unknown as { _textures: Record<string, unknown> })._textures[name]
    expect(vec('wxA')).toBe(before)
    expect(vec('scCamera')).toBeInstanceOf(Vector4)
    expect(mat.options.defines.some(d => d.includes('SRO_HDR'))).toBe(true)
    if (chunkSampler) expect(tex(chunkSampler)).toBeTruthy()
    // Later sets and defines reach it too.
    const after = new Vector4(5, 6, 7, 8)
    s.sharedUniforms.set('wxB', after)
    expect(vec('wxB')).toBe(after)
    s.setDefine('SRO_GRASS_CSM', true)
    expect(mat.options.defines.some(d => d.includes('SRO_GRASS_CSM'))).toBe(true)
    const shared = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    s.sharedUniforms.set('nlGrassSplat', shared)
    expect(tex('nlGrassSplat')).toBe(shared)
    // A depth texture is bound at bind time (the CSM tap), never as a colour fallback.
    const depth = { name: 'shadowMap' } as unknown as RenderTargetTexture
    s.setDepthTexture('scShadowMap', () => depth)
    expect(mat.onBindObservable.hasObservers()).toBe(true)
    off()
    expect(s.adopts(mat)).toBe(false)
    s.sharedUniforms.set('wxA', new Vector4())
    expect(vec('wxA')).toBe(before)
    // A disposed material leaves by itself.
    const mat2 = new ShaderMaterial('life', scene, 'sroScatter', { attributes: ['position'], uniforms: [] })
    s.adopt(mat2)
    mat2.dispose()
    expect(s.adopts(mat2)).toBe(false)
  })
})

describe('the World wiring (Low never creates the field; the tuft filter; the life slot)', () => {
  function fieldSpy() {
    const made: FakeField[] = []
    const factory = vi.fn<GroundCoverFactory>(() => {
      const f = new FakeField()
      made.push(f)
      return f
    })
    return { made, factory }
  }

  it('Low (Classic) never creates the field, even when asked; the PBR path does, and a switch back drops it', async () => {
    const g = fieldSpy()
    const s = await world({ render: 'classic', grassStyle: 'field', parts: { grass: g.factory } })
    await s.run()
    expect(g.factory).not.toHaveBeenCalled()
    expect(s.world.scatter.style).toBe('retail')
    expect(s.world.retailTuftsHidden).toBe(false)
    s.world.setRenderMode('pbr')
    expect(g.factory).toHaveBeenCalledTimes(1)
    expect(s.world.scatter.style).toBe('field')
    expect(s.world.retailTuftsHidden).toBe(true)
    await s.run()
    expect(g.made[0]!.regions.size).toBe(s.stream.stats.ready)
    s.world.setRenderMode('classic')
    expect(g.made[0]!.disposed).toBe(true)
    expect(s.world.scatter.style).toBe('retail')
    expect(s.world.retailTuftsHidden).toBe(false)
  })

  it('Low places every tuft model, and so does hideRetailTufts: false (the stage) with the new grass', async () => {
    let tuft = -1
    const edit = (fx: Parameters<typeof addModel>[0]) => {
      tuft = addModel(fx, TUFT_SOURCE)
    }
    const low = await world({ render: 'classic', edit })
    await low.run()
    const regions = low.stream.stats.ready
    expect(low.models.loads).toContain(tuft)
    expect(low.world.objects.stats.chunks).toBe(2 * regions)

    const stage = await world({ render: 'pbr', grassStyle: 'field', hideRetailTufts: false, parts: { grass: () => new FakeField() }, edit })
    await stage.run()
    expect(stage.world.scatter.style).toBe('field')
    expect(stage.models.loads).toContain(tuft)
    expect(stage.world.objects.stats.chunks).toBe(2 * regions)

    const medium = await world({ render: 'pbr', grassStyle: 'field', parts: { grass: () => new FakeField() }, edit })
    await medium.run()
    expect(medium.models.loads).not.toContain(tuft)
    expect(medium.world.objects.stats.chunks).toBe(regions)
    // Back to the retail grass: the tufts come back (a rebuild places them).
    medium.world.setGrassStyle('retail')
    expect(medium.world.retailTuftsHidden).toBe(false)
    await medium.run()
    expect(medium.world.objects.stats.chunks).toBe(2 * regions)
  })

  it('the tuft list is GRASS_LIFE §1.3\'s six low models (695 placements in jangan-fields)', () => {
    expect([...RETAIL_TUFT_MODELS].sort()).toEqual(['grass_single03', 'group_grs01', 'group_grs03_1', 'grs_weed01', 'grs_weed02', 'grs_weed07'])
    expect(isRetailTuftModel({ source: TUFT_SOURCE })).toBe(true)
    expect(isRetailTuftModel({ source: 'res\\nature\\common\\grass\\grs_weed09_1.bsr' })).toBe(false)
    expect(isRetailTuftModel({ source: 'res\\nature\\common\\flower\\flw_g01_wha.bsr' })).toBe(false)
    expect(modelStem('res\\nature\\common\\grass\\GRS_WEED07.bsr')).toBe('grs_weed07')
    expect([SCATTER_TAG, LIFE_TAG]).toEqual(['scatter', 'life'])
    // D33: Low keeps the retail scatter (no grass style), Medium+ ask for the new grass.
    expect(QUALITY_PRESETS.low.grassStyle).toBeUndefined()
    expect(['medium', 'high', 'ultra'].map(q => QUALITY_PRESETS[q as 'medium'].grassStyle)).toEqual(['field', 'field', 'field'])
  })

  it('World.life: made on the PBR path with the world, updated after the scatter, switched by the flag, disposed with it', async () => {
    const order: string[] = []
    const made: FakeLife[] = []
    const life = vi.fn<LifeFactory>(host => {
      expect(host.world).toBeDefined()
      const l = new FakeLife(order)
      made.push(l)
      return l
    })
    const classic = await world({ render: 'classic', parts: { life } })
    expect(classic.world.life).toBeNull()
    expect(life).not.toHaveBeenCalled()

    const s = await world({ render: 'pbr', wildlife: false, parts: { life } })
    const l = made[0]!
    expect(s.world.life).toBe(l)
    expect(l.enabled).toBe(false)
    const scatterUpdate = s.world.scatter.update.bind(s.world.scatter)
    vi.spyOn(s.world.scatter, 'update').mockImplementation(cam => {
      order.push('scatter')
      scatterUpdate(cam)
    })
    s.scene.createDefaultCamera()
    s.world.update()
    expect(order).toEqual(['scatter', 'life'])
    s.world.setQuality({ ...QUALITY_PRESETS.medium, wildlife: true })
    expect(l.enabled).toBe(true)
    // The stage's switch (D25) and the app's threats pass straight through.
    s.world.life!.configure({ groundFlocks: false })
    expect(l.configs).toEqual([{ groundFlocks: false }])
    // Classic drops it; PBR makes a new one.
    s.world.setRenderMode('classic')
    expect(l.disposed).toBe(true)
    expect(s.world.life).toBeNull()
    s.world.setRenderMode('pbr')
    expect(s.world.life).toBe(made[1])
    s.dispose()
    expect(made[1]!.disposed).toBe(true)
  })
})
