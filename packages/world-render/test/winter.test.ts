/**
 * The snow season's look (winter/**; docs/WINTER.md §7): the snow plugins' code (same points in WGSL and GLSL, real
 * Babylon 9.28 injection points, no GLSL idiom in the WGSL), their defines (eligibility, skinned meshes skipped) and the
 * no-recompile rule (the amounts are uniforms; only the on/off gate runs a define pass), the Classic chunks, WorldWinter's
 * gate, ice, flakes and disposal (no leak), the winter grade and the Classic environment.
 */
import { InternalTexture, InternalTextureSource, MeshBuilder, NullEngine, PBRMaterial, Scene, ShaderStore, Skeleton, StandardMaterial, type Mesh } from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import '@babylonjs/core/Shaders/default.fragment.js'
import '@babylonjs/core/ShadersWGSL/default.fragment.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLEAR_FRAME,
  GradeMixer,
  POND_PLANTS,
  SNOWFALL_COUNTS,
  SNOWFALL_SHADERS,
  SNOW_DEFINE,
  SNOW_OFF_DELAY_S,
  SNOW_PLUGIN,
  SNOW_STD_PLUGIN,
  SroSnowPlugin,
  SroSnowStdPlugin,
  WINTER_CHUNKS,
  WinterIce,
  WorldWinter,
  applyWinterToEnv,
  applyWinterToLut,
  installSnow,
  scatterShaders,
  snowPbrCode,
  snowStdCode,
  terrainShaders,
  toRenderWeather,
  toSkyWeather,
  weatherFogScale,
  winterGrade,
  type WeatherFrame,
  type WinterHost,
} from '../src/index.ts'
import { SharedUniforms } from '../src/shader-chunks.ts'
import type { EnvValues } from '../src/environment.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  // NullEngine has no 3D textures (the grade LUT): a CPU-side stand-in, as grade.test.ts
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_d: unknown, w: number, h: number, d: number) => {
    const t = new InternalTexture(engine, InternalTextureSource.Raw3D)
    t.baseWidth = t.width = w
    t.baseHeight = t.height = h
    t.baseDepth = t.depth = d
    t.is3D = true
    t.isReady = true
    return t
  }
  e['updateRawTexture3D'] = () => {}
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

const balanced = (s: string) => (s.match(/#if/g) ?? []).length === (s.match(/#endif/g) ?? []).length
const WGSL_BAD = /\b(float|vec[234]|ivec[234]|texture2D|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/
const WGSL_SWIZZLE_ASSIGN = /\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/
const GLSL_BAD = /\b(fn|let)\s|vec[234]f\(|var<private>|fragmentInputs|vertexOutputs|uniforms\./

/** The fragment of one material type in one language, with every include (the texts the injection points live in). */
function sources(kind: 'pbr' | 'default', lang: 'wgsl' | 'glsl'): string {
  const store = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL : ShaderStore.ShadersStore
  const inc = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  return [store[`${kind}PixelShader`]!, ...Object.values(inc)].join('\n')
}

describe('the snow plugin code (docs/WINTER.md §7.1)', () => {
  it('PBR and Standard: the same points in both languages, each a real point of Babylon 9.28', () => {
    for (const [code, kind] of [[snowPbrCode, 'pbr'], [snowStdCode, 'default']] as const) {
      const w = code('wgsl'), g = code('glsl')
      expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
      for (const lang of ['wgsl', 'glsl'] as const) {
        const src = sources(kind, lang)
        for (const point of Object.keys(w)) expect(src.includes(`#define ${point}`), `${kind} ${lang} ${point}`).toBe(true)
      }
    }
  })

  it('every snippet is guarded and balanced; no GLSL idiom in the WGSL and none of WGSL in the GLSL', () => {
    for (const code of [snowPbrCode, snowStdCode]) {
      for (const [point, s] of Object.entries(code('wgsl'))) {
        expect(balanced(s), point).toBe(true)
        expect(s.trimStart().startsWith('#ifdef SNOW'), point).toBe(true)
        expect(s, point).not.toMatch(WGSL_BAD)
        expect(s, point).not.toMatch(WGSL_SWIZZLE_ASSIGN)
      }
      for (const [point, s] of Object.entries(code('glsl'))) {
        expect(balanced(s), point).toBe(true)
        expect(s, point).not.toMatch(GLSL_BAD)
      }
    }
    // the PBR snow reads the names those shaders have
    expect(sources('pbr', 'wgsl')).toMatch(/geometricNormalW/)
    expect(sources('pbr', 'glsl')).toMatch(/geometricNormalW/)
  })

  it('the Classic chunks: the terrain and every grass shader, behind SRO_SNOW, the uniforms in the lists', () => {
    expect(SNOW_DEFINE).toBe('SRO_SNOW')
    const t = terrainShaders()
    const g = scatterShaders()
    for (const s of [t.fragmentWGSL, t.fragmentGLSL, g.vertexWGSL, g.vertexGLSL, g.fragmentWGSL, g.fragmentGLSL]) expect(s).toMatch(/#ifdef SRO_SNOW/)
    expect(t.uniforms).toEqual(expect.arrayContaining(['snwA', 'snwB']))
    expect(g.uniforms).toEqual(expect.arrayContaining(['snwA', 'snwB']))
    for (const part of [WINTER_CHUNKS.terrain!, WINTER_CHUNKS.grass!]) {
      expect(Object.keys(part.wgsl!).sort()).toEqual(Object.keys(part.glsl!).sort())
      for (const s of Object.values(part.wgsl!)) {
        expect(balanced(s)).toBe(true)
        expect(s).not.toMatch(WGSL_BAD)
        expect(s).not.toMatch(WGSL_SWIZZLE_ASSIGN)
      }
      for (const s of Object.values(part.glsl!)) expect(s).not.toMatch(GLSL_BAD)
    }
    // the terrain's derivatives are taken outside any branch (the chunk rule), and the flakes are WGSL on WebGPU
    expect(SNOWFALL_SHADERS.wgsl.vertex).not.toMatch(WGSL_BAD)
  })
})

const definesOf = (mesh: Mesh) => mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>

async function ready(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material!
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

describe('the snow plugins on NullEngine materials (docs/WINTER.md §7.1)', () => {
  it('are attached at creation once a scene has snow; snow only on world materials, never on skinned meshes', async () => {
    const scene = nullScene()
    const before = new PBRMaterial('before', scene)
    const state = installSnow(scene)
    expect(before.pluginManager?.getPlugin(SNOW_PLUGIN)).toBeInstanceOf(SroSnowPlugin) // existing ones too
    const roof = new PBRMaterial('roof', scene)
    roof.metadata = { snowObj: true }
    const actor = new PBRMaterial('actor', scene)
    actor.metadata = { snowObj: true }
    const std = new StandardMaterial('wall', scene)
    std.metadata = { snowObj: true }
    expect(roof.pluginManager?.getPlugin(SNOW_PLUGIN)).toBeInstanceOf(SroSnowPlugin)
    expect(std.pluginManager?.getPlugin(SNOW_STD_PLUGIN)).toBeInstanceOf(SroSnowStdPlugin)
    const roofMesh = MeshBuilder.CreateBox('roof', { size: 1 }, scene)
    roofMesh.material = roof
    const actorMesh = MeshBuilder.CreateBox('actor', { size: 1 }, scene)
    actorMesh.material = actor
    actorMesh.skeleton = new Skeleton('s', 's', scene)
    const plain = MeshBuilder.CreateBox('fx', { size: 1 }, scene)
    plain.material = before
    const stdMesh = MeshBuilder.CreateBox('wall', { size: 1 }, scene)
    stdMesh.material = std
    for (const m of [roofMesh, actorMesh, plain, stdMesh]) expect(await ready(m)).toBe(true)
    expect(definesOf(roofMesh).SNOW).toBe(false) // off until the gate opens
    state.setOn(true)
    for (const m of [roofMesh, actorMesh, plain, stdMesh]) expect(await ready(m)).toBe(true)
    expect(definesOf(roofMesh).SNOW).toBe(true)
    expect(definesOf(actorMesh).SNOW).toBe(false)
    expect(definesOf(plain).SNOW).toBe(false)
    expect(definesOf(stdMesh).SNOWC).toBe(true)
    state.setOn(false)
    expect(await ready(roofMesh)).toBe(true)
    expect(definesOf(roofMesh).SNOW).toBe(false)
  })

  it('no recompile from frame to frame: the cover, the frost and the light are uniforms; only the gate compiles', async () => {
    const scene = nullScene()
    const state = installSnow(scene)
    const roof = new PBRMaterial('roof', scene)
    roof.metadata = { snowObj: true }
    const mesh = MeshBuilder.CreateBox('roof', { size: 1 }, scene)
    mesh.material = roof
    state.setOn(true)
    expect(await ready(mesh)).toBe(true)
    const effect = mesh.subMeshes[0]!.effect!
    expect(effect.defines.split('\n')).toContain('#define SNOW')
    for (let i = 0; i < 120; i++) {
      state.a.set(i / 120, 1 - i / 240, (i % 7) / 7, (i % 13) / 13)
      state.b.set(0.7, 0.71, 0.73, 0.8 + (i % 3) * 0.01)
      scene.incrementRenderId()
      expect(roof.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true)
      expect(mesh.subMeshes[0]!.effect).toBe(effect)
    }
    // the gate: a new effect without the snow code, then back to the snowy one (Babylon's effect cache)
    state.setOn(false)
    expect(await ready(mesh)).toBe(true)
    const off = mesh.subMeshes[0]!.effect!
    expect(off.uniqueId).not.toBe(effect.uniqueId)
    expect(off.defines.split('\n')).not.toContain('#define SNOW')
    state.setOn(true)
    expect(await ready(mesh)).toBe(true)
    expect(mesh.subMeshes[0]!.effect!.uniqueId).toBe(effect.uniqueId)
  })
})

// ---- WorldWinter on a stand-in world -------------------------------------------------------------------------

function standIn(scene: Scene, level: 'off' | 'low' | 'high' = 'high') {
  const defines: Record<string, boolean[]> = { terrain: [], scatter: [] }
  const winterK: number[] = []
  const water = [MeshBuilder.CreateGround('water_1_2', { width: 4, height: 4 }, scene)]
  water[0]!.position.y = 3
  const plant = MeshBuilder.CreateBox('c_pondflower#0', { size: 0.2 }, scene)
  // a region batch's group of its own (materials.ts batchClass): known by its material's source model, not its name
  const batched = MeshBuilder.CreateBox('batch:31:3:cutout', { size: 0.2 }, scene)
  batched.material = new StandardMaterial('grs_lotus_01', scene)
  const pondMat = batched.material
  const host: WinterHost = {
    scene,
    terrain: { sharedUniforms: new SharedUniforms(), setDefine: (n, on) => n === SNOW_DEFINE && defines.terrain!.push(on) },
    scatter: { sharedUniforms: new SharedUniforms(), setDefine: (n, on) => n === SNOW_DEFINE && defines.scatter!.push(on), setWinter: k => winterK.push(k) },
    water: { meshes: water },
    objects: { meshes: () => [plant, batched] },
    materials: { batchRecord: (m: unknown) => (m === pondMat ? { model: { source: 'res\\nature\\common\\grass\\c_pondflower.bsr' } } : null) },
    render: { mode: 'pbr' },
    sky: { state: { night: 0 } },
    weather: { level, precipColor: [0.5, 0.52, 0.55] },
  }
  return { host, defines, winterK, water, plant, batched }
}

const frame = (f: Partial<WeatherFrame>): WeatherFrame => ({ ...CLEAR_FRAME, ...f })

describe('WorldWinter (docs/WINTER.md §7)', () => {
  it('stays off without snow; the gate opens with the first snow and closes SNOW_OFF_DELAY_S after it has gone', () => {
    const scene = nullScene()
    const s = standIn(scene)
    const w = new WorldWinter(scene)
    w.attach(s.host)
    expect(s.host.terrain.sharedUniforms.get('snwA')).toBe(w.state.a)
    w.setFrame(frame({}))
    for (let i = 0; i < 10; i++) w.update(0.1, null)
    expect(w.on).toBe(false)
    expect(s.defines.terrain).toEqual([])
    w.setFrame(frame({ cover: 0.3, frost: 0.2 }))
    w.update(0.1, null)
    expect(w.on).toBe(true)
    expect(s.defines).toEqual({ terrain: [true], scatter: [true] })
    expect(w.state.a.x).toBeCloseTo(0.3, 9)
    expect(w.state.a.y).toBeCloseTo(0.2, 9)
    w.setFrame(frame({}))
    for (let t = 0; t < SNOW_OFF_DELAY_S - 1; t += 0.5) w.update(0.5, null)
    expect(w.on).toBe(true)
    for (let i = 0; i < 4; i++) w.update(0.5, null)
    expect(w.on).toBe(false)
    expect(s.defines).toEqual({ terrain: [true, false], scatter: [true, false] })
    expect(s.winterK.at(-1)).toBe(0)
  })

  it('freezes the ponds past the frost threshold (ice raised, pond plants hidden) and thaws them back', () => {
    const scene = nullScene()
    const s = standIn(scene)
    const w = new WorldWinter(scene)
    w.attach(s.host)
    const water = s.water[0]!
    const mat = water.material
    w.setFrame(frame({ frost: 1, cover: 0.5 }))
    w.update(0.1, null)
    expect(water.material?.name).toBe('winterIce')
    expect((water.material?.metadata as { snowIce?: boolean }).snowIce).toBe(true)
    expect(water.position.y).toBeCloseTo(2.98, 6)
    expect(s.plant.layerMask).toBe(0)
    expect(s.batched.layerMask).toBe(0)
    expect(w.stats().frozen).toBe(3)
    w.setFrame(frame({ frost: 0.2 }))
    w.update(0.1, null)
    expect(water.material).toBe(mat)
    expect(water.position.y).toBe(3)
    expect(s.plant.layerMask).toBe(0x0fffffff)
    expect(s.batched.layerMask).toBe(0x0fffffff)
    expect(POND_PLANTS.test('res\\nature\\common\\tree\\w12\\lily_pads.bsr')).toBe(true)
  })

  it('makes flakes only while it snows and only for a weather level that draws them', () => {
    const scene = nullScene()
    const off = standIn(scene, 'off')
    const w0 = new WorldWinter(scene)
    w0.attach(off.host)
    w0.setFrame(frame({ snow: 1, cover: 1 }))
    w0.update(0.1, null)
    expect(w0.stats().flakes).toBe(0)
    w0.dispose()
    const s = standIn(scene, 'low')
    const w = new WorldWinter(scene)
    w.attach(s.host)
    w.setFrame(frame({ cover: 1 }))
    w.update(0.1, null)
    expect(w.stats().flakes).toBe(0)
    w.setFrame(frame({ cover: 1, snow: 0.6 }))
    w.update(0.1, null)
    expect(w.stats().flakes).toBe(SNOWFALL_COUNTS.low[0])
    expect(SNOWFALL_COUNTS.high[0] + SNOWFALL_COUNTS.high[1]).toBe(25_000)
    w.dispose()
  })

  it('disposes everything it made (no leak across worlds)', () => {
    const scene = nullScene()
    const meshes0 = scene.meshes.length
    const s = standIn(scene)
    void scene.defaultMaterial // Babylon's own, made once per scene on first use
  const base = { meshes: scene.meshes.length, materials: scene.materials.length }
    for (let k = 0; k < 3; k++) {
      const w = new WorldWinter(scene)
      w.attach(s.host)
      w.setFrame(frame({ snow: 1, cover: 1, frost: 1 }))
      for (let i = 0; i < 5; i++) w.update(0.1, scene.activeCamera)
      w.dispose()
      expect(scene.meshes.map(m => m.name).slice(base.meshes)).toEqual([])
      expect(scene.meshes.length).toBe(base.meshes)
      expect(scene.materials.map(m => m.name).slice(base.materials)).toEqual([])
      expect(s.host.terrain.sharedUniforms.has('snwA')).toBe(false)
      expect(s.water[0]!.material).toBeNull()
    }
    expect(meshes0).toBeLessThan(base.meshes)
  })
})

describe('the winter look on the weather inputs, the grade and the Classic palette (docs/WINTER.md §7.6)', () => {
  it('the frame: snow closes the view, hazes the sky, drives the winter grade; a frame without winter fields is as before', () => {
    expect(toRenderWeather(CLEAR_FRAME).winter).toBeUndefined()
    expect(toRenderWeather(frame({ frost: 1, cover: 0.2 })).winter).toBeCloseTo(0.6, 9)
    expect(toRenderWeather(frame({ frost: 0.5, cover: 1 })).winter).toBe(1)
    expect(toSkyWeather(frame({ snow: 1 })).precipitation).toBeCloseTo(0.7, 9)
    expect(weatherFogScale(frame({ snow: 1 })).end).toBeCloseTo(0.7, 9)
    expect(weatherFogScale(CLEAR_FRAME)).toEqual({ start: 1, end: 1 })
  })

  it('the winter grade: cold by day, the opposite of the night blue by night, more contrast under a flat sky', () => {
    const day = winterGrade(0, 0)
    const night = winterGrade(1, 0)
    expect(day.gain[2]).toBeGreaterThan(day.gain[0])
    expect(night.gain[2]).toBeLessThan(1)
    expect(night.gain[0]).toBeGreaterThan(1)
    expect(winterGrade(0, 1).contrast).toBeGreaterThan(day.contrast)
    const lut = new Uint8Array([200, 200, 200, 255, 40, 60, 90, 255])
    const copy = lut.slice()
    applyWinterToLut(lut, night, 0)
    expect(lut).toEqual(copy)
    applyWinterToLut(lut, night, 1)
    expect(lut[2]).toBeLessThan(lut[0]!) // white at night is no longer blue-shifted by the step
  })

  it('the grade mixer re-uploads when the winter weight moves, and only then', () => {
    const scene = nullScene()
    const g = new GradeMixer(scene)
    cleanups.push(() => g.dispose())
    const input = { sunElevationDeg: 40, t: 0.5, cloud: 0.9, rain: 0 }
    expect(g.update(input)).toBe(true)
    expect(g.update(input)).toBe(false)
    expect(g.update({ ...input, winter: 0.005 })).toBe(false)
    expect(g.update({ ...input, winter: 0.5 })).toBe(true)
    expect(g.update({ ...input, winter: 0.505 })).toBe(false)
    expect(g.update({ ...input, winter: 0 })).toBe(true)
  })

  it('the Classic palette: identity without winter; with it the fog whitens by day, the night stays as it is', () => {
    const env: EnvValues = {
      sun: [1, 0.9, 0.8], skyTop: [0.3, 0.4, 0.7], skyBottom: [0.6, 0.7, 0.8], diffuse: [0.9, 0.85, 0.8], objectAmbient: [0.4, 0.4, 0.4], scatter: [0, 0, 0],
      terrainShadow: [0.3, 0.3, 0.3], fogColor: [0.55, 0.6, 0.5], water: [0.2, 0.3, 0.4], g7: 0, g8: 0, g10: 0.2, g11: 0.9,
    }
    expect(applyWinterToEnv(env, 0, 0)).toBe(env)
    const d = applyWinterToEnv(env, 1, 1, 0)
    const spread = (c: readonly number[]) => Math.max(...c) - Math.min(...c)
    expect(spread(d.fogColor)).toBeLessThan(spread(env.fogColor))
    expect(d.objectAmbient[0]).toBeGreaterThan(env.objectAmbient[0])
    const n = applyWinterToEnv(env, 1, 1, 1)
    expect(n.fogColor).toEqual(env.fogColor)
    expect(n.objectAmbient).toEqual(env.objectAmbient)
  })
})
