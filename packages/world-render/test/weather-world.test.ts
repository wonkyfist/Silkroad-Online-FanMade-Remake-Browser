/**
 * World weather in a NullEngine world (docs/WAVE_PLAN3.md §6.8, docs/WEATHER.md §6, §9.1):
 *  - Off draws nothing (no mesh, texture, render target or define) but binds the shared vectors;
 *  - Medium turns on the chunk defines, builds the ripple texture, the shelter map, the rain and one wet map per region
 *    (a commit job after the terrain, bound as the region's `wetMap`); the shelter map is not rendered while dry;
 *  - `setWeatherLevel('off')` disposes the rain meshes, the shelter render target, the ripples and the wet maps;
 *  - `attachWetness` wets converted object materials (not unlit or alpha-blended ones) and refuses a material that
 *    carries a RENDER plugin (D19);
 *  - the wind speeds up the skinned trees and the water animation, and bends the grass only from level Low up.
 */
import { AssetContainer, Mesh, MaterialPluginBase, NullEngine, PBRMaterial, Scene, ShaderMaterial, StandardMaterial, type Material } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { weatherParams, type WeatherKind } from '../../shared/src/weather.ts'
import { CLEAR_FRAME, WETNESS_PLUGIN, WetnessPlugin, attachWetness, isWeatherMesh, loadWorld, type World, type WeatherFrame, type WeatherLevel } from '../src/index.ts'
import { wetnessPlugins } from '../src/weather/wet-plugin.ts'
import { N, ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function world(level: WeatherLevel, opts: { stream?: boolean; quality?: 'low' | 'medium' } = {}): Promise<{ world: World; scene: Scene }> {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const fx = makeFixture()
  const w = await loadWorld(scene, {
    baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: opts.stream ?? false,
    quality: opts.quality ?? 'low', weatherLevel: level,
  })
  cleanups.push(() => {
    w.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { world: w, scene }
}

function frame(kind: WeatherKind, surface: { wet?: number; puddle?: number } = {}): WeatherFrame {
  const p = weatherParams(kind)
  return {
    cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat,
    windX: 0.8, windZ: -0.6, windMs: p.windMs, gustMs: p.windMs * 1.3, wet: surface.wet ?? p.rain, puddle: surface.puddle ?? p.rain * 0.8,
    flash: 0, flashX: 0, flashZ: 1, time: 100,
  }
}

const FOCUS = { x: 96, z: -96 }
const defines = (m: ShaderMaterial | null | undefined) => (m?.options.defines ?? []).map(d => d.replace('#define ', '').replace(/ true$/, '')).sort()
const vectors = (m: ShaderMaterial) => (m as unknown as { _vectors4: Record<string, unknown> })._vectors4

describe('weather level Off (the Low guard)', () => {
  it('draws nothing: no weather mesh, texture, render target or define; the shared vectors are bound', async () => {
    const { world: w, scene } = await world('off')
    w.setWeather(frame('storm'))
    for (let i = 0; i < 3; i++) w.update(null, FOCUS)
    expect(scene.meshes.filter(isWeatherMesh)).toEqual([])
    expect(w.weather.rain).toBeNull()
    expect(w.weather.shelter).toBeNull()
    expect(w.weather.rippleTexture).toBeNull()
    expect(scene.customRenderTargets).toEqual([])
    expect(scene.textures.some(t => /^(wx|wetMap)/.test(t.name))).toBe(false)
    for (const m of [...w.terrain.materials, w.water.material!]) expect(defines(m)).toEqual([])
    // The always-on terms read these (the flash and the Classic-sky overcast light).
    expect(vectors(w.terrain.materials[0]!).wxF).toBe(w.weather.u.wxF)
    expect(vectors(w.terrain.materials[0]!).wxC).toBe(w.weather.u.wxC)
    expect(vectors(w.water.material!).wxA).toBe(w.weather.u.wxA)
    expect(w.weather.stats()).toMatchObject({ level: 'off', streaks: 0, shelter: false, shelterRenders: 0, wetMaps: 0 })
  })

  it('a clear frame leaves the overcast terms off and the flash at 0', async () => {
    const { world: w } = await world('off')
    w.setWeather(CLEAR_FRAME)
    w.update(null, FOCUS)
    expect(w.weather.u.wxF.w).toBe(0)
    expect(w.weather.u.wxC.w).toBe(0)
    w.setWeather(frame('overcast'))
    w.update(null, FOCUS)
    // Classic sky (the default here): the overcast light is on.
    expect(w.weather.u.wxF.w).toBe(1)
    expect(w.weather.u.wxF.y).toBeCloseTo(1 - 0.28 * weatherParams('overcast').cloudDark, 9)
  })
})

describe('weather level Medium', () => {
  it('turns on the chunk defines, the ripples, the shelter map and the rain', async () => {
    const { world: w, scene } = await world('medium')
    const t = w.terrain.materials[0]!
    expect(defines(t)).toEqual(['WX', 'WX_OCC8', 'WX_PUDDLE', 'WX_REFL', 'WX_RIPPLE', 'WX_SHELTER'].filter(d => d !== 'WX_OCC8' || w.weather.shelterTexture()!.packed).sort())
    expect(defines(w.water.material)).toEqual(['WX_WATER'])
    expect(w.weather.rippleTexture?.getSize().width).toBe(128)
    expect(w.weather.shelter).not.toBeNull()
    expect(w.weather.rain?.box).not.toBeNull()
    expect(w.weather.rain?.splashes).not.toBeNull()
    expect(w.weather.rain?.drips).not.toBeNull()
    expect(w.weather.rain?.bolt).toBeNull()
    expect(scene.meshes.filter(isWeatherMesh).length).toBe(4)
    // Every weather mesh sits in group 0 with the explicit sort tier (never group 1, which clears depth).
    for (const m of scene.meshes.filter(isWeatherMesh)) {
      expect(m.renderingGroupId).toBe(0)
      expect(m.alphaIndex).toBe(Number.MAX_VALUE)
      expect(m.isEnabled()).toBe(false)
    }
  })

  it('builds one wet map per region (a commit job) and binds it as the region\'s wetMap', async () => {
    const { world: w } = await world('medium')
    w.update(null, FOCUS)
    expect(w.weather.stats().wetMaps).toBe(N * N)
    const g = w.terrain.region(w.regions.regions[0]!.region.id)!
    expect(g.textures.wetMap).toBeDefined()
    expect((g.material as unknown as { _textures: Record<string, unknown> })._textures.wetMap).toBe(g.textures.wetMap)
  })

  it('a streamed world gets the wet map as its own commit step after the terrain', async () => {
    const { world: w } = await world('medium', { stream: true })
    w.update(null, FOCUS)
    expect(w.stream?.commitSteps).toContain('wetMap')
  })

  it('the shelter map is not rendered while dry, and is requested once it rains', async () => {
    const { world: w, scene } = await world('medium')
    const cam = new (await import('@babylonjs/core')).FreeCamera('cam', new (await import('@babylonjs/core')).Vector3(96, 20, -96), scene)
    scene.activeCamera = cam
    w.setWeather(CLEAR_FRAME)
    for (let i = 0; i < 5; i++) {
      w.update(cam, FOCUS)
      scene.render()
    }
    expect(w.weather.stats().shelterRenders).toBe(0)
    expect(scene.customRenderTargets).toEqual([])
    w.setWeather(frame('rain'))
    for (let i = 0; i < 3; i++) {
      w.update(cam, FOCUS)
      scene.render()
    }
    expect(scene.customRenderTargets).toContain(w.weather.shelter!.texture)
    // Rain draws: the box and the curtain are on, the streak count follows the rain rate.
    expect(w.weather.rain!.box!.isEnabled()).toBe(true)
    expect(w.weather.stats().streaks).toBe(Math.round(10000 * weatherParams('rain').rain))
  })

  it('setWeatherLevel(\'off\') disposes the rain meshes, the shelter render target, the ripples and the wet maps', async () => {
    const { world: w, scene } = await world('medium')
    w.update(null, FOCUS)
    const rain = w.weather.rain!
    const meshes = rain.meshes()
    const rt = w.weather.shelter!.texture
    const ripple = w.weather.rippleTexture!
    const g = w.terrain.region(w.regions.regions[0]!.region.id)!
    const wet = g.textures.wetMap!
    w.setWeatherLevel('off')
    for (const m of meshes) expect(m.isDisposed()).toBe(true)
    expect(scene.meshes.filter(isWeatherMesh)).toEqual([])
    expect(w.weather.shelter).toBeNull()
    expect(rt.getInternalTexture()).toBeNull()
    expect(scene.customRenderTargets).not.toContain(rt)
    expect(ripple.getInternalTexture()).toBeNull()
    expect(w.weather.rippleTexture).toBeNull()
    expect(g.textures.wetMap).toBeUndefined()
    expect(wet.getInternalTexture()).toBeNull()
    expect(w.weather.stats().wetMaps).toBe(0)
    for (const m of [...w.terrain.materials, w.water.material!]) expect(defines(m)).toEqual([])
    // And back: everything is rebuilt.
    w.setWeatherLevel('high')
    w.update(null, FOCUS)
    expect(w.weather.rain?.bolt).not.toBeNull()
    expect(w.weather.rippleTexture?.getSize().width).toBe(256)
    expect(defines(w.terrain.materials[0]!)).toContain('WX_RIPPLE2')
  })
})

describe('the wetness plugin on materials', () => {
  class FakeRenderPlugin extends MaterialPluginBase {
    constructor(mat: Material) {
      super(mat, 'SroSurfacePlugin', 100, {})
    }
    override isCompatible(): boolean {
      return true
    }
  }

  it('refuses a material that carries a RENDER plugin (D19), and turns itself off if one arrives later', async () => {
    const { scene } = await world('medium')
    const pbr = new PBRMaterial('surface', scene)
    new FakeRenderPlugin(pbr)
    expect(attachWetness(pbr, 'static')).toBeNull()
    expect(pbr.pluginManager!.getPlugin(WETNESS_PLUGIN)).toBeNull()

    const late = new PBRMaterial('late', scene)
    const p = attachWetness(late, 'actor')!
    expect(p).toBeInstanceOf(WetnessPlugin)
    const d: Record<string, boolean> = {}
    p.prepareDefines(d as never, scene, null as never)
    expect(d.WX).toBe(true)
    new FakeRenderPlugin(late)
    p.prepareDefines(d as never, scene, null as never)
    expect(d.WX).toBe(false)
    // Not a Standard or PBR material: nothing.
    expect(attachWetness(new ShaderMaterial('sh', scene, 'x', {}), 'static')).toBeNull()
  })

  it('follows the level: WX off at Off, on at Low; reflection and shelter from Medium; foliage sway from High', async () => {
    const { world: w, scene } = await world('off')
    const std = new StandardMaterial('roof_tile_01', scene)
    const tree = new StandardMaterial('tre_leaf', scene)
    const p = attachWetness(std, 'static')!
    const t = attachWetness(tree, 'static', { source: 'res\\nature\\china\\jangan\\tree\\tre_pine01.bsr' })!
    const d = () => {
      const o: Record<string, boolean> = {}
      p.prepareDefines(o as never, scene, null as never)
      const q: Record<string, boolean> = {}
      t.prepareDefines(q as never, scene, null as never)
      return { std: o, tree: q }
    }
    expect(d().std.WX).toBe(false)
    w.setWeatherLevel('low')
    expect(d().std).toMatchObject({ WX: true, WX_REFL: false, WX_SHELTER: false })
    w.setWeatherLevel('medium')
    expect(d().std).toMatchObject({ WX: true, WX_REFL: true, WX_SHELTER: true })
    expect(d().tree.WX_FOLIAGE).toBe(false)
    w.setWeatherLevel('high')
    expect(d().tree.WX_FOLIAGE).toBe(true)
    expect(d().std.WX_FOLIAGE).toBe(false)
    // Class and foliage parameters: roof tiles are glossier than foliage.
    expect(p.params.gloss).toBeGreaterThan(t.params.gloss)
    expect(t.params).toEqual({ porosity: 0.4, gloss: 0.5 })
    expect(wetnessPlugins(scene)).toEqual(expect.arrayContaining([p, t]))
  })

  it('the object decorator wets converted materials, but not unlit or alpha-blended ones', async () => {
    const { world: w, scene } = await world('medium')
    const c = new AssetContainer(scene)
    const mk = (name: string) => {
      const m = new PBRMaterial(name, scene)
      c.materials.push(m)
      const mesh = new Mesh(`${name}_mesh`, scene)
      mesh.material = m
      c.meshes.push(mesh)
      return m
    }
    mk('wall_stone')
    mk('lantern_glow')
    mk('glass_blend')
    const converted = await w.materials.convert(c, {
      materials: [
        { name: 'wall_stone', flags: 0, diffuse: [0.6, 0.6, 0.6], ambient: [0.6, 0.6, 0.6], texture: 'prim\\mtrl\\wall_stone01.ddj' },
        { name: 'lantern_glow', flags: 0x8, diffuse: [1, 1, 1], ambient: [1, 1, 1] },
        { name: 'glass_blend', flags: 0, diffuse: [1, 1, 1], ambient: [1, 1, 1], alphaMode: 'BLEND' },
      ],
    }, false, { model: 'm.glb', source: 'res\\bldg\\china\\jangan\\wall.bsr', kind: 'static' })
    const byName = new Map(converted.materials.map(m => [m.name, m]))
    const plugin = (n: string) => byName.get(n)!.pluginManager?.getPlugin(WETNESS_PLUGIN) ?? null
    expect(plugin('wall_stone')).toBeInstanceOf(WetnessPlugin)
    expect(plugin('lantern_glow')).toBeNull()
    expect(plugin('glass_blend')).toBeNull()
  })
})

describe('wind', () => {
  it('a storm speeds up the skinned trees and the water animation; calm is the retail speed', async () => {
    const { world: w } = await world('low')
    w.setWeather(CLEAR_FRAME)
    w.update(null, FOCUS)
    expect(w.water.animationRate).toBe(1)
    expect(w.objects['speed'].to).toBe(1)
    w.setWeather({ ...frame('storm'), gustMs: 20 })
    w.update(null, FOCUS)
    expect(w.water.animationRate).toBeCloseTo(1.8, 6)
    expect(w.objects['speed'].to).toBeCloseTo(2.2, 6)
  })

  it('the grass takes the weather wind from Low up; Off keeps the retail sway (the Low guard)', async () => {
    const { world: w } = await world('off')
    const scatter = w.scatter as unknown as { defines: { has(n: string): boolean } }
    expect(scatter.defines.has('WX_WIND')).toBe(false)
    w.setWeatherLevel('low')
    expect(scatter.defines.has('WX_WIND')).toBe(true)
    expect(scatter.defines.has('WX')).toBe(true)
    expect(scatter.defines.has('WX_SHELTER')).toBe(false)
  })
})
