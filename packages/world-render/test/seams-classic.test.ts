/**
 * The Low guard (docs/WAVE_PLAN3.md §4.4, D1, D4): with every shader chunk empty, the Classic terrain, water and grass
 * shaders are HEAD's byte for byte (golden/head-shaders.ts); a world on Low + classic sky + weather off builds the same
 * material classes, defines, textures and environment values as before the wave-9 seams; the layer-map alpha carries
 * the surface class without changing the shader's "no layer" test. Also: non-empty chunks land at their points, in
 * the fixed lane order. This test must stay green after every merge.
 */
import { NullEngine, RawTexture, Scene, ShaderMaterial, ShaderStore, StandardMaterial } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLEAR_FRAME,
  FOG_RANGE_M,
  QUALITY_PRESETS,
  RENDER_PRESETS,
  TERRAIN_SURFACE,
  WORLD_SHADER_CHUNKS,
  loadWorld,
  scatterShaders,
  surfaceAlpha,
  surfaceFromAlpha,
  terrainShaders,
  terrainSurfaceClass,
  waterShaders,
  type World,
  type WorldShaderChunks,
} from '../src/index.ts'
import * as now from '../src/shaders.ts'
import * as grass from '../src/scatter-assets.ts'
import * as head from './golden/head-shaders.ts'
import { BASE_URL, N, ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

describe('Classic shaders with empty chunks equal HEAD (golden copies)', () => {
  const cases: Array<[string, string, string]> = [
    ['terrain vertex WGSL', terrainShaders([]).vertexWGSL, head.terrainVertexWGSL],
    ['terrain fragment WGSL', terrainShaders([]).fragmentWGSL, head.terrainFragmentWGSL],
    ['terrain vertex GLSL', terrainShaders([]).vertexGLSL, head.terrainVertexGLSL],
    ['terrain fragment GLSL', terrainShaders([]).fragmentGLSL, head.terrainFragmentGLSL],
    ['water vertex WGSL', waterShaders([]).vertexWGSL, head.waterVertexWGSL],
    ['water fragment WGSL', waterShaders([]).fragmentWGSL, head.waterFragmentWGSL],
    ['water vertex GLSL', waterShaders([]).vertexGLSL, head.waterVertexGLSL],
    ['water fragment GLSL', waterShaders([]).fragmentGLSL, head.waterFragmentGLSL],
    ['grass vertex WGSL', scatterShaders([]).vertexWGSL, head.scatterVertexWGSL],
    ['grass fragment WGSL', scatterShaders([]).fragmentWGSL, head.scatterFragmentWGSL],
    ['grass vertex GLSL', scatterShaders([]).vertexGLSL, head.scatterVertexGLSL],
    ['grass fragment GLSL', scatterShaders([]).fragmentGLSL, head.scatterFragmentGLSL],
  ]
  it.each(cases)('%s', (_name, built, golden) => {
    expect(built).toBe(golden)
  })

  it('the uniform and sampler lists with no chunks equal HEAD', () => {
    expect(terrainShaders([]).uniforms).toEqual(head.TERRAIN_UNIFORMS)
    expect(terrainShaders([]).samplers).toEqual(head.TERRAIN_SAMPLERS)
    expect(waterShaders([]).uniforms).toEqual(head.WATER_UNIFORMS)
    expect(waterShaders([]).samplers).toEqual(head.WATER_SAMPLERS)
    expect(scatterShaders([]).uniforms).toEqual(head.SCATTER_UNIFORMS)
    expect(scatterShaders([]).samplers).toEqual(head.SCATTER_SAMPLERS)
    expect(terrainShaders([]).chunkSamplers).toEqual([])
  })

  it('the exported constants are the build of the lane chunk files (HEAD while every lane is empty)', () => {
    const t = terrainShaders(WORLD_SHADER_CHUNKS), w = waterShaders(WORLD_SHADER_CHUNKS), g = scatterShaders(WORLD_SHADER_CHUNKS)
    expect([now.terrainVertexWGSL, now.terrainFragmentWGSL, now.terrainVertexGLSL, now.terrainFragmentGLSL]).toEqual([t.vertexWGSL, t.fragmentWGSL, t.vertexGLSL, t.fragmentGLSL])
    expect([now.waterVertexWGSL, now.waterFragmentWGSL, now.waterVertexGLSL, now.waterFragmentGLSL]).toEqual([w.vertexWGSL, w.fragmentWGSL, w.vertexGLSL, w.fragmentGLSL])
    expect([grass.scatterVertexWGSL, grass.scatterFragmentWGSL, grass.scatterVertexGLSL, grass.scatterFragmentGLSL]).toEqual([g.vertexWGSL, g.fragmentWGSL, g.vertexGLSL, g.fragmentGLSL])
    expect([now.TERRAIN_UNIFORMS, now.TERRAIN_SAMPLERS, grass.SCATTER_UNIFORMS, grass.SCATTER_SAMPLERS]).toEqual([t.uniforms, t.samplers, g.uniforms, g.samplers])
    if (WORLD_SHADER_CHUNKS.every(l => Object.keys(l).length === 0)) {
      expect(now.terrainFragmentWGSL).toBe(head.terrainFragmentWGSL)
      expect(now.waterFragmentGLSL).toBe(head.waterFragmentGLSL)
      expect(grass.scatterVertexWGSL).toBe(head.scatterVertexWGSL)
    }
  })
})

describe('chunk points (a lane that fills them)', () => {
  const tag = (lane: string, point: string, lang: string) => `// <${lane}:${point}:${lang}>\n`
  function lane(name: string): WorldShaderChunks {
    const pts = {
      terrain: ['uniforms', 'varyings', 'vertexDecl', 'samplers', 'vertexOut', 'layer', 'preLight', 'lightTerm', 'postLight'],
      water: ['uniforms', 'varyings', 'vertexDecl', 'samplers', 'vertexOut', 'normal', 'postColor'],
      grass: ['uniforms', 'varyings', 'vertexDecl', 'samplers', 'vertexSway', 'vertexLight', 'fragmentColor'],
    } as const
    const out: Record<string, unknown> = {}
    for (const [shader, list] of Object.entries(pts)) {
      const code = (lang: string) => Object.fromEntries(list.map(p => [p, tag(name, `${shader}.${p}`, lang)]))
      out[shader] = { uniforms: [`${name}U`], samplers: [`${name}S`], vWorld: true, wgsl: code('wgsl'), glsl: code('glsl') }
    }
    return out as WorldShaderChunks
  }
  const lanes = [lane('sky'), lane('weather')]

  it('terrain: every point is at its place in both languages, sky before weather', () => {
    const t = terrainShaders(lanes)
    for (const [lang, src, vsrc] of [['wgsl', t.fragmentWGSL, t.vertexWGSL], ['glsl', t.fragmentGLSL, t.vertexGLSL]] as const) {
      const at = (l: string, p: string, s = src) => s.indexOf(tag(l, `terrain.${p}`, lang))
      for (const p of ['uniforms', 'varyings', 'samplers', 'layer', 'preLight', 'lightTerm', 'postLight']) {
        expect(at('sky', p), `${lang} ${p}`).toBeGreaterThan(-1)
        expect(at('sky', p)).toBeLessThan(at('weather', p))
      }
      for (const p of ['uniforms', 'varyings', 'vertexDecl', 'vertexOut']) expect(at('sky', p, vsrc), `${lang} vertex ${p}`).toBeGreaterThan(-1)
      // layer inside the loop after `drawn = k + 1`, with the class in scope; preLight before the lightmap block;
      // lightTerm inside it on the mutable copy; postLight before fog.
      expect(at('sky', 'layer')).toBeGreaterThan(src.indexOf('drawn = k + 1;'))
      // TT-Q: the class is masked (`& 63`) past the no-anti-tile bit (64), so the classes Low reads are unchanged.
      expect(src).toContain(lang === 'wgsl' ? 'let sroClass = i32(t.a * 255.0 + 0.5) & 63;' : 'int sroClass = int(t.a * 255.0 + 0.5) & 63;')
      expect(at('sky', 'preLight')).toBeLessThan(src.indexOf('viewParams.x > 0.5'))
      expect(at('sky', 'lightTerm')).toBeGreaterThan(src.indexOf('viewParams.x > 0.5'))
      expect(src).toContain('lmT + ')
      expect(at('weather', 'postLight')).toBeLessThan(src.indexOf('fogParams.z > 0.5'))
      expect(src).toContain(lang === 'wgsl' ? 'let albedo = color;' : 'vec3 albedo = color;')
      expect(src).toContain(lang === 'wgsl' ? 'varying vWorld: vec3f;' : 'varying vec3 vWorld;')
      expect(vsrc).toContain(lang === 'wgsl' ? 'vertexOutputs.vWorld = wp.xyz;' : 'vWorld = wp.xyz;')
    }
    expect(t.uniforms.slice(-2)).toEqual(['skyU', 'weatherU'])
    expect(t.samplers.slice(-2)).toEqual(['skyS', 'weatherS'])
    expect(t.chunkSamplers).toEqual(['skyS', 'weatherS'])
  })

  it('water: normal and postColor before fog, with the mutable normal', () => {
    const w = waterShaders(lanes)
    for (const [lang, src] of [['wgsl', w.fragmentWGSL], ['glsl', w.fragmentGLSL]] as const) {
      const n = src.indexOf(tag('sky', 'water.normal', lang))
      const c = src.indexOf(tag('weather', 'water.postColor', lang))
      expect(n).toBeGreaterThan(src.indexOf(lang === 'wgsl' ? 'var nrm = vec3f(0.0, 1.0, 0.0);' : 'vec3 nrm = vec3(0.0, 1.0, 0.0);'))
      expect(c).toBeGreaterThan(n)
      expect(c).toBeLessThan(src.indexOf('fogParams.z > 0.5'))
    }
  })

  it('grass: vertexSway replaces the fixed sway line; vertexLight ends the vertex main; fragmentColor before fog', () => {
    const g = scatterShaders(lanes)
    expect(g.vertexWGSL).not.toContain('vec3f(0.8, 0.0, 0.6)')
    expect(g.vertexGLSL).not.toContain('vec3(0.8, 0.0, 0.6)')
    expect(g.vertexWGSL.indexOf(tag('sky', 'grass.vertexSway', 'wgsl'))).toBeLessThan(g.vertexWGSL.indexOf('vertexOutputs.position ='))
    expect(g.vertexGLSL.indexOf(tag('weather', 'grass.vertexLight', 'glsl'))).toBeGreaterThan(g.vertexGLSL.indexOf('vDepth ='))
    expect(g.fragmentWGSL.indexOf(tag('sky', 'grass.fragmentColor', 'wgsl'))).toBeLessThan(g.fragmentWGSL.indexOf('fogParams.z > 0.5'))
    expect(g.vertexWGSL).toContain('vertexOutputs.vWorld = p;')
  })
})

describe('Low + classic sky + weather off builds what HEAD built', () => {
  async function lowWorld(fx = makeFixture()): Promise<{ world: World; scene: Scene }> {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const world = await loadWorld(scene, {
      baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'low',
    })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    return { world, scene }
  }

  it('defaults: classic material path, classic sky, weather off, clear frame', async () => {
    const { world } = await lowWorld()
    expect(world.render.mode).toBe('classic')
    expect(world.materials.mode).toBe('classic')
    expect(world.skyStyle).toBe('classic')
    expect(world.weather.level).toBe('off')
    expect(world.weatherState).toBe(CLEAR_FRAME)
    expect(world.render.quality).toBe(RENDER_PRESETS.low)
    expect(world.render.parts()).toEqual([])
    expect(QUALITY_PRESETS.low).toEqual({ drawDistance: 0.6, animated: false, water: true, scatter: 'low' })
  })

  it('the same material classes, meshes, lights, defines and textures', async () => {
    const { world, scene } = await lowWorld()
    const byClass = new Map<string, number>()
    for (const m of scene.materials) byClass.set(m.getClassName(), (byClass.get(m.getClassName()) ?? 0) + 1)
    // The retail dome (StandardMaterial 'sky'; setting it up before the mesh has it makes Babylon create its lazy
    // 'default material', as at HEAD), one terrain ShaderMaterial per region, the shared water material.
    expect(Object.fromEntries(byClass)).toEqual({ StandardMaterial: 2, ShaderMaterial: N * N + 1 })
    expect(scene.materials.map(m => m.name).filter(n => !world.terrain.materials.some(t => t.name === n))).toEqual(['sky', 'default material', 'water'])
    expect(scene.lights.map(l => l.name)).toEqual(['worldSun'])
    expect(scene.meshes.map(m => m.name).sort()).toEqual(['sky', ...world.terrain.meshes.map(m => m.name)].sort())
    for (const m of [...world.terrain.materials, world.water.material!]) {
      expect(m).toBeInstanceOf(ShaderMaterial)
      // No define on Low + classic sky + weather off: every chunk feature sits behind one.
      expect(m.options.defines ?? []).toEqual([])
      // HEAD's textures, plus only the fallback for a sampler a lane chunk declares.
      const extra = m === world.water.material ? now.WATER_CHUNK_SAMPLERS : now.TERRAIN_CHUNK_SAMPLERS
      expect(Object.keys((m as unknown as { _textures: Record<string, unknown> })._textures).sort()).toEqual(
        [...(m === world.water.material ? ['frames'] : ['layerMap', 'lightmap', 'tiles']), ...extra].sort())
    }
    expect(ShaderStore.ShadersStore['sroTerrainFragmentShader']).toBe(now.terrainFragmentGLSL)
    expect(ShaderStore.ShadersStoreWGSL['sroTerrainFragmentShader']).toBe(now.terrainFragmentWGSL)
    expect(ShaderStore.ShadersStore['sroWaterFragmentShader']).toBe(now.waterFragmentGLSL)
    expect(scene.getMaterialByName('sky')).toBeInstanceOf(StandardMaterial)
  })

  it('the environment values are the retail palette exactly (fog 190..250 m for the fallback palette)', async () => {
    const { world, scene } = await lowWorld()
    world.update(null, { x: 96, z: -96 })
    const env = world.skyState.env
    expect(scene.fogStart).toBe(env.g10 * FOG_RANGE_M)
    expect(scene.fogEnd).toBe(env.g11 * FOG_RANGE_M)
    expect(world.fogRange).toEqual({ start: env.g10 * FOG_RANGE_M, end: env.g11 * FOG_RANGE_M })
    const mat = world.terrain.materials[0]! as unknown as { _vectors4: Record<string, { x: number; y: number; z: number }> }
    expect(mat._vectors4.fogParams!.x).toBe(env.g10 * FOG_RANGE_M)
    expect(mat._vectors4.fogParams!.y).toBe(env.g11 * FOG_RANGE_M)
    expect(world.sun.diffuse.r).toBeCloseTo(env.diffuse[0] * 0.6, 12)
    // A clear frame (weather off) changes nothing.
    world.setWeather(CLEAR_FRAME)
    world.update(null, { x: 96, z: -96 })
    expect(scene.fogEnd).toBe(world.skyState.env.g11 * FOG_RANGE_M)
  })

  it('the layer-map alpha is 128 + the surface class, still >= 0.5 for the "no layer" test', async () => {
    for (let c = 0; c < 6; c++) {
      const a = surfaceAlpha(c)
      expect(a / 255).toBeGreaterThanOrEqual(0.5)
      expect(surfaceFromAlpha(a / 255)).toBe(c)
    }
    expect(terrainSurfaceClass({ typeName: 'Grass' })).toBe(TERRAIN_SURFACE.grass)
    expect(terrainSurfaceClass({ typeName: 'Dirt', file: 'tiles/c_marble_jang_08_1.png' })).toBe(TERRAIN_SURFACE.stone)
    expect(terrainSurfaceClass({ typeName: 'Mud' })).toBe(TERRAIN_SURFACE.dirt)
    expect(terrainSurfaceClass({ typeName: 'Ashfield' })).toBe(TERRAIN_SURFACE.sand)
    expect(terrainSurfaceClass({ typeName: 'DeepWater' })).toBe(TERRAIN_SURFACE.water)
    expect(terrainSurfaceClass({ typeName: null as unknown as undefined })).toBe(TERRAIN_SURFACE.generic)

    // The terrain writes it: tile 10 is Grass, tile 11 a marble source (stone), tile 12 untyped (generic).
    const fx = makeFixture()
    const tiles = fx.manifest.tiles as Array<{ id: number; typeName: string | null; source: string }>
    tiles.find(t => t.id === 10)!.typeName = 'Grass'
    tiles.find(t => t.id === 11)!.source = 'c_marble_jang_01.ddj'
    fx.files.set(`${BASE_URL}manifest.json`, new TextEncoder().encode(JSON.stringify(fx.manifest)))
    const spy = vi.spyOn(RawTexture, 'CreateRGBATexture')
    await lowWorld(fx)
    const alphas = new Set<number>()
    for (const call of spy.mock.calls) {
      if (call[1] !== 96) continue
      const data = call[0] as Uint8Array
      for (let i = 3; i < data.length; i += 4) if (data[i]) alphas.add(data[i]!)
    }
    // The marble tile also carries TT-Q's no-anti-tile bit (132 + 64); its class read back (`& 63`) is still stone.
    expect([...alphas].sort()).toEqual([128, 129, 196])
    expect([...alphas].map(a => surfaceFromAlpha(a / 255)).sort()).toEqual([TERRAIN_SURFACE.generic, TERRAIN_SURFACE.grass, TERRAIN_SURFACE.stone])
  })
})
