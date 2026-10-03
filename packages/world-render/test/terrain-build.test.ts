/**
 * Headless `buildRegion` on both material paths (docs/WAVE_PLAN3.md §6.11; docs/RENDER.md RND-T): the Classic branch
 * is unchanged (ShaderMaterial, uv attribute, no normals) with or without a render source; the PBR branch builds a
 * PBRMaterial carrying SroTerrainPlugin, per-vertex normals and no uv, binds per-region textures by reference, follows
 * the preset / weather level / lanes' defines through setParams, and frees everything on dispose. A world loaded with
 * `render: 'pbr'` builds its terrain on the PBR path through World's wiring.
 */
import { NullEngine, PBRMaterial, RawTexture, Scene, ShaderMaterial, VertexBuffer } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CELLS, GRID } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { loadWorld } from '../src/index.ts'
import { SRO_TERRAIN_PLUGIN, parseExtern, type SroTerrainPlugin, type TerrainExterns } from '../src/pbr/terrain-plugin.ts'
import { RENDER_PRESETS, type RenderQuality } from '../src/render/quality.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from '../src/render/weather.ts'
import { WorldRegions, type RegionData } from '../src/regions.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { TerrainRenderer, type TerrainParams, type TerrainRenderSource } from '../src/terrain.ts'
import { WEATHER_PRESETS } from '../src/weather/presets.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const PARAMS: TerrainParams = { lightmap: true, fog: true, fogStartM: 50, fogEndM: 250, fogColor: [0.5, 0.6, 0.7], shadowColor: [0, 0, 0], view: 0 }
const NIGHT: TerrainExterns = {
  shelter: null,
  cloudShadow: null,
  nightSplat: { ...parseExtern('sroNightSplat', 'fn sroNightSplat(t: texture_2d<f32>, s: sampler, lp: vec2f, n: f32) -> vec3f { return vec3f(n); }', 'vec3 sroNightSplat(sampler2D t, vec2 lp, float n) { return vec3(n); }'), uniforms: [{ name: 'nlNight', type: 'vec4' }], samplers: ['nightSplat'] },
}

function setup(externs?: TerrainExterns) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => engine.dispose())
  const manifest = {
    space: { originRegion: { x: 100, z: 100 } },
    tiles: [{ id: 1, file: 'tiles/grass.png', typeName: 'Grass' }, { id: 2, file: 'tiles/road_stone.png', typeName: 'Dirt' }],
  } as unknown as WorldManifest
  const regions = new WorldRegions(manifest)
  const terrain = new TerrainRenderer(scene, regions, { externs })
  const data = (x: number, z = 100): RegionData => {
    const layers = new Uint8Array(CELLS * CELLS * 4 * 2)
    for (let c = 0; c < CELLS * CELLS; c++) {
      layers.set([1, 0, 255, 255], c * 4)
      layers.set([2, 4, 5, 255], (CELLS * CELLS + c) * 4)
    }
    const heights = new Float32Array(GRID * GRID).map((_, i) => (i % GRID) * 0.1)
    const d: RegionData = {
      region: { id: (z << 8) | x, x, z, origin: [192 * (x - 100), 0, 192 * (100 - z)] } as never,
      terrain: { version: 1, layerCount: 2, heights, normals: new Int8Array(GRID * GRID * 4), textures: new Uint16Array(GRID * GRID), layers },
      navmesh: null,
    }
    regions.add(d)
    return d
  }
  return { engine, scene, terrain, regions, data }
}

/** A mutable render source (tests swap the preset / weather like World does). */
function source(quality: Readonly<RenderQuality> = RENDER_PRESETS.high, weather: Readonly<RenderWeather> = CLEAR_RENDER_WEATHER) {
  const s = {
    render: { mode: 'pbr' as 'classic' | 'pbr', quality, weather },
    sky: { quality: SKY_PRESETS.high, state: { exposure: 8 } },
    weather: { preset: WEATHER_PRESETS.medium },
  }
  return s as typeof s & TerrainRenderSource
}

describe('buildRegion, Classic path', () => {
  it('builds today\'s ShaderMaterial region with or without a (classic) render source', () => {
    for (const follow of [false, true]) {
      const { terrain, data } = setup()
      if (follow) terrain.follow({ render: { mode: 'classic', quality: RENDER_PRESETS.low, weather: CLEAR_RENDER_WEATHER } })
      const g = terrain.buildRegion(data(100), id => id - 1, null)
      expect(g.path).toBe('classic')
      expect(g.pbr).toBeNull()
      expect(g.material).toBeInstanceOf(ShaderMaterial)
      expect(terrain.materials).toEqual([g.material])
      expect(terrain.pbrMaterials).toEqual([])
      expect(g.mesh.isVerticesDataPresent(VertexBuffer.UVKind)).toBe(true)
      expect(g.mesh.isVerticesDataPresent(VertexBuffer.NormalKind)).toBe(false)
      expect(g.mesh.applyFog).toBe(false)
      terrain.setParams(PARAMS) // the Classic per-frame path never touches the PBR state
      expect((terrain as unknown as { pbrState: unknown }).pbrState).toBeNull()
    }
  })
})

describe('buildRegion, PBR path', () => {
  it('a PBRMaterial with SroTerrainPlugin, normals and no uv; the region record carries the plugin', () => {
    const { terrain, data } = setup()
    terrain.follow(source())
    const lm = RawTexture.CreateRGBATexture(new Uint8Array([200, 200, 200, 255]), 1, 1, terrain.scene)
    const g = terrain.buildRegion(data(100), id => id - 1, lm)
    expect(g.path).toBe('pbr')
    expect(g.material).toBeInstanceOf(PBRMaterial)
    const plugin = (g.material as PBRMaterial).pluginManager!.getPlugin<SroTerrainPlugin>(SRO_TERRAIN_PLUGIN)!
    expect(plugin).toBe(g.pbr)
    expect(plugin.getClassName()).toBe('SroTerrainPlugin')
    expect(plugin.region).toMatchObject({ originX: 0, originZ: 0, layerCount: 2, layerMap: g.layerMap, lightmap: lm })
    expect(terrain.pbrMaterials).toEqual([g.material])
    expect(terrain.materials).toEqual([])
    expect(g.mesh.isVerticesDataPresent(VertexBuffer.NormalKind)).toBe(true)
    expect(g.mesh.isVerticesDataPresent(VertexBuffer.UVKind)).toBe(false)
    expect(g.mesh.receiveShadows).toBe(true)
    expect(g.mesh.metadata).toMatchObject({ sroWorld: 'terrain' })
  })

  it('per-region textures bind by reference; setParams feeds the shared vectors every frame', () => {
    const { terrain, data } = setup()
    const src = source(RENDER_PRESETS.high, { ...CLEAR_RENDER_WEATHER, rain: 0.8, wetness: 0.6, puddles: 0.3, wind: 1.2 })
    terrain.follow(src)
    const g = terrain.buildRegion(data(100), () => 0, null)
    const wet = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, terrain.scene)
    expect(terrain.setRegionTexture(g.id, 'wetMap', wet)).toBe(true)
    expect(g.pbr!.region.textures.wetMap).toBe(wet)
    terrain.setParams({ ...PARAMS, lightmap: false, view: 2 })
    const s = terrain.pbr
    expect([s.weather.x, s.weather.y, s.weather.z, s.weather.w]).toEqual([0.8, 0.6, 0.3, 1.2])
    expect([s.params.x, s.params.y]).toEqual([0, 2])
    expect(s.sun.w).toBeCloseTo(1 / 8)
    expect(terrain.setRegionTexture(g.id, 'wetMap', null)).toBe(true)
    expect(g.pbr!.region.textures.wetMap).toBeUndefined()
  })

  it('the define set follows the preset, the weather level and NL\'s define — never the weather values', () => {
    const { terrain, data } = setup(NIGHT)
    const src = source(RENDER_PRESETS.medium)
    terrain.follow(src)
    terrain.buildRegion(data(100), () => 0, null)
    const f = () => terrain.pbr.features
    expect(f()).toMatchObject({ triplanar: false, wet: true, puddles: true, nightSplat: false })
    let dirty = 0
    for (const p of terrain.pbr.plugins) {
      const mark = p.markAllDefinesAsDirty
      ;(p as { markAllDefinesAsDirty: () => void }).markAllDefinesAsDirty = () => {
        dirty++
        mark()
      }
    }
    src.render.weather = { ...CLEAR_RENDER_WEATHER, rain: 1, wetness: 1, puddles: 1 }
    terrain.setParams(PARAMS)
    expect(dirty).toBe(0) // rain changes uniforms only
    src.render.quality = RENDER_PRESETS.high
    terrain.setParams(PARAMS)
    expect(f().triplanar).toBe(true)
    expect(dirty).toBe(1)
    src.weather.preset = WEATHER_PRESETS.off
    terrain.setParams(PARAMS)
    expect(f()).toMatchObject({ wet: false, puddles: false, ripples: false })
    terrain.setDefine('SRO_NIGHT_SPLAT', true)
    expect(f().nightSplat).toBe(true)
    expect(dirty).toBe(3)
  })

  it('map arrays switch per-layer normals on (High) and are bound through the shared state', () => {
    const { terrain, data } = setup()
    terrain.follow(source(RENDER_PRESETS.high))
    terrain.buildRegion(data(100), () => 0, null)
    expect(terrain.pbr.features.normals).toBe(false)
    const n = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, terrain.scene)
    const o = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, terrain.scene)
    terrain.setMapArrays({ normal: n, ormh: o })
    expect(terrain.pbr.features).toMatchObject({ normals: true, ormh: true })
    expect(terrain.pbr.normals).toBe(n)
    terrain.setMapArrays({ normal: null, ormh: null })
    expect(terrain.pbr.features).toMatchObject({ normals: false, ormh: false })
  })

  it('disposeRegion frees the material, the plugin\'s membership and the layer map; dispose clears the state', () => {
    const { terrain, data } = setup()
    terrain.follow(source())
    const g = terrain.buildRegion(data(100), () => 0, null)
    const plugin = g.pbr!
    expect(terrain.pbr.plugins.has(plugin)).toBe(true)
    expect(terrain.disposeRegion(g.id)).toBe(true)
    expect(terrain.pbrMaterials).toEqual([])
    expect(terrain.pbr.plugins.has(plugin)).toBe(false)
    expect(g.layerMap.getInternalTexture()).toBeNull()
    terrain.buildRegion(data(101), () => 0, null)
    terrain.dispose()
    expect(terrain.meshes).toEqual([])
    expect(terrain.pbrMaterials).toEqual([])
  })

  it('switching the source to classic builds new regions on the Classic path again', () => {
    const { terrain, data } = setup()
    const src = source()
    terrain.follow(src)
    expect(terrain.buildRegion(data(100), () => 0, null).path).toBe('pbr')
    src.render.mode = 'classic'
    expect(terrain.buildRegion(data(100), () => 0, null).path).toBe('classic')
    expect(terrain.pbrMaterials).toEqual([])
  })
})

describe('World wiring', () => {
  it('loadWorld({ render: "pbr" }) builds the terrain on the PBR path; the default stays Classic', async () => {
    for (const render of ['pbr', undefined] as const) {
      const fx = makeFixture()
      const engine = new NullEngine()
      const scene = new Scene(engine)
      scene.useRightHandedSystem = true
      const world = await loadWorld(scene, {
        baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'high', render,
      })
      cleanups.push(() => {
        world.dispose()
        scene.dispose()
        engine.dispose()
      })
      const t = world.terrain
      expect(t.mode).toBe(render ?? 'classic')
      if (render === 'pbr') {
        expect(t.materials).toEqual([])
        expect(t.pbrMaterials.length).toBe(t.meshes.length)
        expect(t.pbr.features).toMatchObject({ triplanar: true, heightBlend: true, detail: true })
        world.update(null)
        expect(t.pbr.sun.w).toBeGreaterThan(0)
      } else {
        expect(t.pbrMaterials).toEqual([])
        expect(t.materials.length).toBe(t.meshes.length)
      }
    }
  })
})
