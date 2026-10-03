/**
 * The generic wave-9 hooks of world-render (docs/WAVE_PLAN3.md §4.1) that later lanes build on: terrain per-region
 * textures, shared uniforms, defines and region observables; water animation rate; the grass shared uniforms;
 * WorldRender forwarding to its parts; the skeleton SkySystem state; the server clock; the sky style and the render
 * path switch; AmbientFx.emitters. NullEngine, synthetic 7 x 7 world.
 */
import { NullEngine, RawTexture, Scene, Vector4, type BaseTexture, type Material } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLOCK, clockAt, type WorldClockState } from '../../shared/src/world-clock.ts'
import { AmbientFx, readAmbientIndex } from '../src/ambient-fx.ts'
import {
  BAKED_LIGHT_DIR,
  RENDER_PRESETS,
  RegionStreamer,
  SKY_PRESETS,
  STREAM_DEFAULTS,
  TERRAIN_REGION_SLOTS,
  loadWorld,
  type RenderPart,
  type World,
} from '../src/index.ts'
import { BASE_URL, CX, CZ, ROOT_URL, WORLD_NAME, fakeModels, makeFixture, makeWorld, settle, type Fixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

async function wholeWorld(fx: Fixture = makeFixture(), quality: 'low' | 'medium' = 'low'): Promise<{ world: World; scene: Scene }> {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality })
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { world, scene }
}

const vec4Of = (m: Material, name: string) => (m as unknown as { _vectors4: Record<string, Vector4> })._vectors4[name]

describe('TerrainRenderer seams', () => {
  it('setRegionTexture records per region (both paths read it); unknown regions answer false', async () => {
    const { world, scene } = await wholeWorld()
    const t = world.terrain
    const id = world.regions.regions[0]!.region.id
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    expect(TERRAIN_REGION_SLOTS).toEqual(['wetMap', 'nightSplat', 'lightmapExtra'])
    expect(t.setRegionTexture(-5, 'wetMap', tex)).toBe(false)
    expect(t.setRegionTexture(id, 'wetMap', tex)).toBe(true)
    expect(t.region(id)!.textures.wetMap).toBe(tex)
    expect(t.setRegionTexture(id, 'wetMap', null)).toBe(true)
    expect(t.region(id)!.textures).toEqual({})
    tex.dispose()
  })

  it('sharedUniforms bind by reference on every region material, now and later; setDefine too', async () => {
    const { world } = await wholeWorld()
    const t = world.terrain
    const v = new Vector4(1, 2, 3, 4)
    t.sharedUniforms.set('wxA', v)
    t.setDefine('SRO_TEST', true)
    for (const m of t.materials) {
      expect(vec4Of(m, 'wxA')).toBe(v)
      expect(m.options.defines).toContain('SRO_TEST true')
    }
    // A region built again (dispose + build) gets the same object and define.
    const data = world.regions.regions[0]!
    const built: number[] = []
    const disposed: number[] = []
    t.onRegionBuilt.add(g => built.push(g.id))
    t.onRegionDisposed.add(id => disposed.push(id))
    const gpu = t.region(data.region.id)!
    const layerOf = (id: number) => id - 10
    expect(t.disposeRegion(data.region.id)).toBe(true)
    expect(disposed).toEqual([data.region.id])
    const again = t.buildRegion(data, layerOf, null)
    expect(built).toEqual([data.region.id])
    expect(again).not.toBe(gpu)
    expect(vec4Of(again.material, 'wxA')).toBe(v)
    expect((again.material as { options: { defines: string[] } }).options.defines).toContain('SRO_TEST true')
    t.setDefine('SRO_TEST', false)
    expect((again.material as { options: { defines: string[] } }).options.defines).not.toContain('SRO_TEST true')
  })
})

describe('WaterRenderer.setAnimationRate', () => {
  it('re-anchors the frame clock so the frame does not jump, then runs at the new rate', async () => {
    const fx = makeFixture()
    const water = fx.manifest.water as { frames: string[]; frameMs: number }
    water.frames = Array.from({ length: 30 }, (_, i) => `water/${i}.png`)
    for (const f of water.frames) fx.files.set(`${BASE_URL}${f}`, new Uint8Array([1]))
    fx.files.set(`${BASE_URL}manifest.json`, new TextEncoder().encode(JSON.stringify(fx.manifest)))
    const { world } = await wholeWorld(fx)
    const w = world.water
    const frame = () => vec4Of(w.material!, 'waterParams')!.x
    const p = { color: [1, 1, 1] as [number, number, number], fog: false, fogStartM: 0, fogEndM: 1, fogColor: [0, 0, 0] as [number, number, number] }
    w.update(1050, p)
    expect(frame()).toBe(10)
    w.setAnimationRate(2)
    expect(w.animationRate).toBe(2)
    w.update(1050, p)
    expect(frame()).toBe(10)
    w.update(1150, p) // 100 ms at 2x = two frames
    expect(frame()).toBe(12)
    w.setAnimationRate(Number.NaN)
    expect(w.animationRate).toBe(1)
    w.update(1150, p)
    expect(frame()).toBe(12)
  })
})

describe('WorldScatter.sharedUniforms', () => {
  it('is a live map with a setDefine', async () => {
    const { world } = await wholeWorld()
    const v = new Vector4()
    world.scatter.sharedUniforms.set('wxB', v)
    expect(world.scatter.sharedUniforms.get('wxB')).toBe(v)
    expect(world.scatter.sharedUniforms.delete('wxB')).toBe(true)
    world.scatter.setDefine('SRO_HDR', true)
  })
})

describe('WorldRender (skeleton hub)', () => {
  it('forwards every call to the parts that are set, in slot order', async () => {
    const { world } = await wholeWorld(makeFixture(), 'medium')
    const r = world.render
    expect(r.mode).toBe('classic')
    expect(r.quality).toBe(RENDER_PRESETS.medium)
    expect(r.gpu.features).toEqual([])
    expect(r.taaJitter.x).toBe(0)
    const calls: string[] = []
    const part = (name: string): RenderPart => ({
      setQuality: () => calls.push(`${name}.quality`),
      update: (_c, sky) => {
        expect(sky).toBe(world.skyState)
        calls.push(`${name}.update`)
      },
      decorateCharacterMaterial: m => calls.push(`${name}.decorate:${m.name}`),
      addCharacter: m => calls.push(`${name}.add:${m.name}`),
      dispose: () => calls.push(`${name}.dispose`),
    })
    r.post = part('post')
    r.lighting = part('lighting')
    world.setQuality('high')
    expect(r.quality).toBe(RENDER_PRESETS.high)
    expect(world.sky.quality).toBe(SKY_PRESETS.high)
    world.update(null, { x: 96, z: -96 })
    expect(calls).toEqual(['lighting.quality', 'post.quality', 'lighting.update', 'post.update'])
    calls.length = 0
    const mesh = world.terrain.meshes[0]!
    r.addCharacter(mesh)
    expect(r.characterMeshes.has(mesh)).toBe(true)
    r.decorateCharacterMaterials({ materials: [world.terrain.materials[0]!] } as never)
    expect(calls).toEqual([`lighting.add:${mesh.name}`, `post.add:${mesh.name}`, `lighting.decorate:${world.terrain.materials[0]!.name}`, `post.decorate:${world.terrain.materials[0]!.name}`])
    // D20: the renderer's rain occlusion is the weather's shelter map.
    expect(r.rainOcclusion).toBeNull()
    const shelter = { texture: {} as BaseTexture, centerX: 0, centerY: 0, centerZ: 0, sizeM: 128, valid: true, topAt: () => null }
    world.weather.shelter = shelter
    expect(r.rainOcclusion).toBe(shelter)
    expect(r.rainOcclusionTexture).toBe(shelter.texture)
    world.weather.shelter = null
  })

  it('isolateLights is a no-op on the PBR path', async () => {
    const { world } = await wholeWorld()
    world.render.mode = 'pbr'
    world.isolateLights([])
    expect(world.sun.includeOnlyWithLayerMask).toBe(0)
    world.render.mode = 'classic'
    world.isolateLights([])
    expect(world.sun.includeOnlyWithLayerMask).not.toBe(0)
  })
})

describe('SkySystem skeleton and the clock', () => {
  it('fills a valid SkyState from the retail palette (Low: the baked key light)', async () => {
    const { world } = await wholeWorld()
    world.setTimeOfDay(0.5)
    world.update(null, { x: 96, z: -96 })
    const s = world.skyState
    const env = s.env
    expect(s.t).toBe(0.5)
    expect(s.keyLight.dir.equalsWithEpsilon(BAKED_LIGHT_DIR, 1e-9)).toBe(true)
    expect(s.keyLight.color).toEqual([env.diffuse[0] * 0.6, env.diffuse[1] * 0.6, env.diffuse[2] * 0.6])
    expect(s.ambient.sky).toEqual([...env.objectAmbient].slice(0, 3))
    expect(s.sunDir.y).toBeGreaterThan(0.5)
    expect(s.night).toBe(0)
    world.setTimeOfDay(0)
    world.update(null, { x: 96, z: -96 })
    expect(world.skyState.night).toBe(1)
    expect(world.sky.mesh.name).toBe('sky')
  })

  it('setClock runs the time from the server clock; setTimeOfDay freezes it again', async () => {
    const { world } = await wholeWorld()
    let now = 1_000_000
    const clock: WorldClockState = { ...DEFAULT_CLOCK, anchorMs: 0, anchorDays: 10.25 }
    const seen: number[] = []
    world.onSky.add(s => seen.push(s.t))
    world.setClock(clock, () => now)
    expect(world.worldClock).toBe(clock)
    expect(world.timeOfDay).toBeCloseTo(clockAt(clock, now).t, 9)
    now += 60 * 60_000 // one real hour = half a game day
    world.update(null, { x: 96, z: -96 })
    expect(world.timeOfDay).toBeCloseTo(clockAt(clock, now).t, 9)
    expect(world.skyState.day).toBe(clockAt(clock, now).day)
    expect(seen.length).toBeGreaterThan(0)
    world.setTimeOfDay(0.3)
    expect(world.worldClock).toBeNull()
    now += 10 * 60_000
    world.update(null, { x: 96, z: -96 })
    expect(world.timeOfDay).toBeCloseTo(0.3, 12)
  })

  it('setSkyStyle switches the style; the classic sky keeps the retail palette', async () => {
    const { world } = await wholeWorld()
    expect(world.skyStyle).toBe('classic')
    world.setSkyStyle('modern')
    expect(world.sky.style).toBe('modern')
    world.setSkyStyle('classic')
    expect(world.sky.envFor()).toBe(world.skyState.env)
  })
})

describe('World.setRenderMode', () => {
  it('rebuilds a streamed world on the new path; a whole-world load keeps its materials', async () => {
    const fx = makeFixture()
    const { engine, scene, world, chunks } = await makeWorld(fx)
    const models = fakeModels(scene)
    const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
      now: () => 0, autoPump: false, objects: true, nav: chunks, loadModel: models.loadModel, disposeModel: models.disposeModel,
      atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
    })
    world.stream = stream
    stream.booting = false
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    const focus = { x: 96, z: -96 }
    const run = async () => {
      for (let i = 0; i < 600; i++) {
        stream.update(focus, null)
        await settle(2)
        if (stream.stats.ready === 21 && stream.stats.objectsReady === 21 && !stream.stats.jobs) return
      }
    }
    await run()
    expect(world.terrain.regionCount).toBe(21)
    const before = stream.chunk(CX, CZ)!
    world.setRenderMode('pbr')
    expect(world.render.mode).toBe('pbr')
    expect(world.materials.mode).toBe('pbr')
    expect(world.terrain.regionCount).toBe(0)
    expect(world.objects.regionCount()).toBe(0)
    await run()
    expect(world.terrain.regionCount).toBe(21)
    expect(stream.chunk(CX, CZ)).not.toBe(before)

    const { world: whole } = await wholeWorld()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mats = [...whole.terrain.materials]
    whole.setRenderMode('pbr')
    expect(warn).toHaveBeenCalled()
    expect(whole.terrain.materials).toEqual(mats)
  })
})

describe('AmbientFx.emitters', () => {
  it('lists the placed emitters per region and in all, with the owner model', () => {
    const fx = new AmbientFx({ max: 2, range: 30 })
    fx.setIndex(readAmbientIndex({ models: { 1: [{ kind: 'ambient', efp: 'map/lamp.efp', bone: null, position: [0, 3, 0], night: true }] } }))
    fx.add(7, 1, [{ position: [5, 0, 0], rotation: [0, 0, 0, 1] }, { position: [9, 0, 0], rotation: [0, 0, 0, 1] }])
    fx.add(8, 1, [{ position: [1, 0, 0], rotation: [0, 0, 0, 1] }])
    expect(fx.emitters(7).map(e => [e.key, e.position[0], e.night, e.model])).toEqual([['map/lamp.efp', 5, true, 1], ['map/lamp.efp', 9, true, 1]])
    expect(fx.emitters()).toHaveLength(3)
    expect(fx.emitters(99)).toEqual([])
    expect(fx.particles(1)).toHaveLength(1)
    fx.removeRegion(7)
    expect(fx.emitters()).toHaveLength(1)
  })
})
