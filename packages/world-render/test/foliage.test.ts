/**
 * RND-W's foliage and grass (docs/WAVE_PLAN3.md §6.14, D16, D23, D30; docs/RENDER.md §8): SroFoliagePlugin and the
 * grass HDR chunks ship WGSL and GLSL with the same injection points, at points Babylon 9.28's shaders have, without
 * the other language's idioms; the trees use WX-R's shared sway function and the Classic trees' bend (grass, Classic and
 * PBR trees sway together); the wind is deterministic per root; the translucency lights the back side only and is
 * shadowed; the plugin's defines follow the path, the preset and the leaf/trunk and static/skinned split, and the part
 * decorates only the PBR materials of foliage models; the grass feed switches SRO_HDR / SRO_GRASS_CSM only on a path or
 * preset change, binds its uniforms by reference, and its HDR composition keeps the earlier chunks' wetness (×) and
 * lamp light (+ at 1 / exposure).
 */
import {
  Matrix,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  ShaderLanguage,
  ShaderStore,
  Vector2,
  Vector3,
  Vector4,
  type Material,
  type Mesh,
  type RenderTargetTexture,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/Shaders/pbr.vertex.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.vertex.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BAKED_LIGHT_DIR,
  CLEAR_RENDER_WEATHER,
  FOLIAGE_BEND,
  FoliageShared,
  GRASS_CSM_DEFINE,
  GRASS_HDR_DEFINE,
  GRASS_RENDER_UNIFORMS,
  GRASS_SHADOW_SAMPLER,
  MATERIAL_CLASS_PARAMS,
  PbrFoliage,
  RENDER_GRASS_CHUNKS,
  RENDER_PRESETS,
  RenderGrass,
  SRO_FOLIAGE_PLUGIN,
  SroFoliagePlugin,
  SroSurfacePlugin,
  SurfaceShared,
  WORLD_SHADER_CHUNKS,
  bakedWeight,
  foliageBend,
  foliageCode,
  foliagePluginOf,
  foliageTranslucency,
  grassHdr,
  grassSH,
  scatterShaders,
  shIrradiance,
  wrappedNdotL,
  type GrassRenderSource,
  type GrassTarget,
  type RenderPart,
  type RenderQuality,
  type SkyState,
} from '../src/index.ts'
import { SharedUniforms } from '../src/shader-chunks.ts'
import { GRASS_BAKED_MIN, GRASS_LIGHTMAP_FLOOR, grassBakedWeight } from '../src/render/grass-chunks.ts'
import { BAKED_MIN } from '../src/pbr/surface-plugin.ts'
import { TERRAIN_LIGHTMAP_FLOOR } from '../src/pbr/terrain-plugin.ts'
import { WX_SWAY_GLSL, WX_SWAY_WGSL } from '../src/weather/chunks.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import {
  FOLIAGE_MAX_H,
  FOLIAGE_PIVOT_KIND,
  FOLIAGE_TREEW_KIND,
  TREE_BAND_SAMPLER,
  TREE_BAND_TEX_H,
  TREE_BAND_TEX_W,
  TREE_PIVOT_FLOATS,
  TREE_W_AMP_M,
  treeBandShows,
  treeBandTexel,
  treeFlutter,
  treeFoliageCode,
  treeWindAmp,
  treeWindBend,
} from '../src/pbr/foliage-plugin.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

/** A PBR shader stage of one language with every include appended (the texts the injection points live in). */
function pbrSources(lang: 'wgsl' | 'glsl', stage: 'vertex' | 'fragment'): string {
  const key = stage === 'vertex' ? 'pbrVertexShader' : 'pbrPixelShader'
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL[key] : ShaderStore.ShadersStore[key]
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  expect(main, `pbr ${stage} (${lang})`).toBeTruthy()
  return [main, ...Object.values(includes)].join('\n')
}

const GLSL_IN_WGSL = /\b(float|vec[234]|ivec[234]|mat4|texture2D|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/
const WGSL_IN_GLSL = /\b(fn|let|var)\s|vec[234]f\(|mat4x4f|var<private>|fragmentInputs|vertexOutputs|uniforms\./
const balanced = (code: string) => (code.match(/^#if/gm) ?? []).length === (code.match(/^#endif/gm) ?? []).length

// ---- the foliage plugin --------------------------------------------------------------------------------------------

describe('SroFoliagePlugin code', () => {
  it('ships the same injection points in WGSL and GLSL, each a point of the PBR shaders in both languages', () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      const wgsl = foliageCode(stage, 'wgsl')
      const glsl = foliageCode(stage, 'glsl')
      expect(Object.keys(wgsl).sort()).toEqual(Object.keys(glsl).sort())
      for (const lang of ['wgsl', 'glsl'] as const) {
        const src = pbrSources(lang, stage)
        for (const point of Object.keys(wgsl)) {
          if (point.startsWith('!')) {
            // The regex point: Babylon adds each light's diffuse with exactly this statement in both languages.
            expect(new RegExp(point.slice(1)).test(src), `${lang} ${point}`).toBe(true)
          } else {
            expect(src.includes(`#define ${point}`), `${lang} ${stage} ${point}`).toBe(true)
          }
        }
      }
    }
    expect(Object.keys(foliageCode('vertex', 'wgsl')).sort()).toEqual(['CUSTOM_VERTEX_DEFINITIONS', 'CUSTOM_VERTEX_UPDATE_WORLDPOS'])
    expect(Object.keys(foliageCode('fragment', 'wgsl'))).toContain('CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION')
    // Not CUSTOM_LIGHT0_COLOR: Babylon multiplies that colour by the clamped N·L (0 on the back-lit side).
    expect(Object.keys(foliageCode('fragment', 'wgsl'))).not.toContain('CUSTOM_LIGHT0_COLOR')
  })

  it('only names variables the PBR shaders have, keeps each language to itself, and closes every #if', () => {
    const names = { vertex: ['finalWorld', 'worldPos', 'vPositionW'], fragment: ['finalDiffuse', 'surfaceAlbedo', 'viewDirectionW', 'vLightData', 'vLightDiffuse', 'shadow'] }
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const stage of ['vertex', 'fragment'] as const) {
        const src = pbrSources(lang, stage)
        for (const n of names[stage]) expect(src.includes(n), `${lang} ${stage} ${n}`).toBe(true)
        for (const [point, code] of Object.entries(foliageCode(stage, lang))) {
          expect(balanced(code), `${lang} ${point}`).toBe(true)
          if (lang === 'wgsl') {
            expect(code, point).not.toMatch(GLSL_IN_WGSL)
            expect(code, point).not.toMatch(/\?[^:]*:/)
            expect(code, point).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
          } else {
            expect(code, point).not.toMatch(WGSL_IN_GLSL)
          }
        }
      }
    }
  })

  it('sways with WX-R\'s shared function and the Classic trees\' bend (D23)', () => {
    expect(foliageCode('vertex', 'wgsl').CUSTOM_VERTEX_DEFINITIONS).toContain(WX_SWAY_WGSL)
    expect(foliageCode('vertex', 'glsl').CUSTOM_VERTEX_DEFINITIONS).toContain(WX_SWAY_GLSL)
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = foliageCode('vertex', lang).CUSTOM_VERTEX_UPDATE_WORLDPOS!
      expect(code).toContain('sroWind(folRoot)')
      expect(code).toContain('finalWorld[3].xyz') // the instance root
      expect(code).toContain(`${FOLIAGE_BEND}`)
      expect(code).toContain('vPositionW') // the fragment follows the moved vertex
    }
    expect(FOLIAGE_BEND).toBe(0.012) // weather/wet-plugin.ts, the Classic static foliage
  })

  it('bends with the height squared and the wind, not at the root; the phase is a fixed function of the root', () => {
    expect(foliageBend(0, 1, 1)).toBe(0)
    expect(foliageBend(4, 1, 1)).toBeCloseTo(4 * foliageBend(2, 1, 1), 9)
    expect(foliageBend(8, 0, 1)).toBe(0)
    expect(foliageBend(8, 0.9, 1.5)).toBeGreaterThan(0.9) // a storm bends an 8 m crown about a metre
    expect(foliageBend(8, 0.1, 0.6)).toBeLessThan(0.05) // calm: a few centimetres
    // sroWind's phase: dot(root.xz, (0.21, 0.17)), no per-frame randomness, the same in both languages.
    for (const code of [WX_SWAY_WGSL, WX_SWAY_GLSL]) {
      expect(code).toMatch(/dot\(root\.xz, vec2f?\(0\.21, 0\.17\)\)/)
      expect(code).not.toMatch(/random|hash/i)
    }
  })

  it('lights the back side only, shadowed', () => {
    const t = MATERIAL_CLASS_PARAMS.foliage.translucency
    expect(foliageTranslucency(-0.5, 0.2, t)).toBe(0)
    expect(foliageTranslucency(0, 0.2, t)).toBe(0)
    expect(foliageTranslucency(1, 0.3, t)).toBeCloseTo(t / Math.PI, 9)
    expect(foliageTranslucency(1, 0.3, t, 0)).toBe(0)
    expect(foliageTranslucency(1, 0.05, t)).toBeLessThan(foliageTranslucency(1, 0.2, t)) // thin bright leaves glow most
  })
})

function boxWith(scene: Scene, mat: Material): Mesh {
  const box = MeshBuilder.CreateBox('b', { size: 1 }, scene)
  box.material = mat
  return box
}

const definesOf = (mesh: Mesh) => mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>

async function ready(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material as PBRMaterial
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

const WIND = { wxA: new Vector4(0, 0, 0, 3), wxB: new Vector4(0.8, 0.6, 0.5, 3) }

describe('SroFoliagePlugin on a NullEngine PBRMaterial', () => {
  it('its defines follow the shared switches, leaf / trunk and static / skinned', async () => {
    const scene = nullScene()
    const shared = new FoliageShared()
    shared.u = WIND
    const leaf = new PBRMaterial('tre_leaf', scene)
    new SroSurfacePlugin(leaf, new SurfaceShared(), { cls: 'foliage' })
    const p = new SroFoliagePlugin(leaf, shared, { leaf: true, kind: 'static' })
    expect(leaf.pluginManager!.getPlugin(SRO_FOLIAGE_PLUGIN)).toBe(p)
    expect(foliagePluginOf(leaf)).toBe(p)
    const mesh = boxWith(scene, leaf)
    expect(await ready(mesh)).toBe(true)
    let d = definesOf(mesh)
    expect([d.SRO_FOLIAGE, d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_TRANSL]).toEqual([false, false, false, false])

    Object.assign(shared, { active: true, wind: true, translucency: true })
    shared.dirtyAll()
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.SRO_FOLIAGE, d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_TRANSL]).toEqual([true, true, true, true])

    // A skinned tree keeps its retail clip: flutter only.
    const clone = new PBRMaterial('tre_bank_leaf', scene)
    new SroSurfacePlugin(clone, new SurfaceShared(), { cls: 'foliage' })
    new SroFoliagePlugin(clone, shared, { leaf: true, kind: 'clone' })
    const m2 = boxWith(scene, clone)
    expect(await ready(m2)).toBe(true)
    d = definesOf(m2)
    expect([d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_TRANSL]).toEqual([false, true, true])

    // A trunk bends with the crown but neither flutters nor glows.
    const trunk = new PBRMaterial('tre_trunk', scene)
    new SroSurfacePlugin(trunk, new SurfaceShared(), { cls: 'wood' })
    new SroFoliagePlugin(trunk, shared, { leaf: false, kind: 'static' })
    const m3 = boxWith(scene, trunk)
    expect(await ready(m3)).toBe(true)
    d = definesOf(m3)
    expect([d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_TRANSL]).toEqual([true, false, false])

    // No weather vectors: nothing moves.
    shared.u = null
    shared.dirtyAll()
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_TRANSL]).toEqual([false, false, true])
  })
})

describe('PbrFoliage', () => {
  function setup(mode: 'classic' | 'pbr', quality: Readonly<RenderQuality>) {
    const scene = nullScene()
    const decorators: Array<(mat: Material, info: { source: string; kind: 'static' | 'clone'; alpha: 'opaque' | 'mask' | 'blend' }) => void> = []
    const materials = { addDecorator: (fn: (typeof decorators)[number]) => { decorators.push(fn); return () => { decorators.splice(decorators.indexOf(fn), 1) } } }
    const render = { mode, quality }
    const part = new PbrFoliage(scene, materials, render, { u: { ...WIND } as never })
    cleanups.push(() => part.dispose())
    const convert = (name: string, source: string, cls: 'foliage' | 'wood' | 'stone' | null, kind: 'static' | 'clone' = 'static') => {
      const mat = new PBRMaterial(name, scene)
      if (cls) new SroSurfacePlugin(mat, new SurfaceShared(), { cls })
      for (const fn of decorators) fn(mat, { source, kind, alpha: 'mask' })
      return mat
    }
    return { scene, part, render, convert, decorators }
  }

  it('decorates only the PBR materials of foliage models, by the model rule', () => {
    const { part, convert } = setup('pbr', RENDER_PRESETS.high)
    const leaf = convert('tre_tree09_01', 'res/nature/china/jangan/tree/tre_tree09.bsr', 'foliage')
    const trunk = convert('tre_tree02_02ss', 'res/nature/china/jangan/tree/tre_tree09.bsr', 'wood')
    const wall = convert('jangan_wall', 'res/bldg/jangan/wall.bsr', 'stone')
    const classic = convert('tre_x', 'res/nature/china/jangan/tree/tre_tree09.bsr', null) // no surface plugin: not the PBR path
    expect(foliagePluginOf(leaf)?.leaf).toBe(true)
    expect(foliagePluginOf(trunk)?.leaf).toBe(false)
    expect(foliagePluginOf(wall)).toBeNull()
    expect(foliagePluginOf(classic)).toBeNull()
    expect(part.shared.plugins.size).toBe(2)
    expect([part.shared.active, part.shared.wind, part.shared.translucency]).toEqual([true, true, true])
    // The ShadowDepthWrapper is opt-in (Babylon 9.28 builds invalid WGSL for it on PBR + prepass).
    expect(part.shared.csmCaster).toBe(false)
    expect(leaf.shadowDepthWrapper).toBeFalsy()
  })

  it('follows the path and the preset before each render, never the weather', () => {
    const { scene, part, render } = setup('classic', RENDER_PRESETS.low)
    expect(part.shared.active).toBe(false)
    const frame = () => scene.onBeforeRenderObservable.notifyObservers(scene)
    render.mode = 'pbr'
    render.quality = RENDER_PRESETS.medium
    frame()
    expect([part.shared.active, part.shared.wind, part.shared.translucency]).toEqual([true, true, true])
    render.quality = { ...RENDER_PRESETS.medium, foliage: { ...RENDER_PRESETS.medium.foliage, translucency: false } }
    frame()
    expect(part.shared.translucency).toBe(false)
    render.mode = 'classic'
    frame()
    expect(part.shared.active).toBe(false)
  })

  it('the Low preset has no foliage feature (the Classic path stays HEAD\'s)', () => {
    expect(RENDER_PRESETS.low.foliage).toEqual({ wind: false, translucency: false, csmCaster: false, grassRootShadow: false })
  })
})

// ---- the grass -----------------------------------------------------------------------------------------------------

describe('grass HDR chunks', () => {
  const chunk = RENDER_GRASS_CHUNKS.grass!

  it('fill the same points in WGSL and GLSL, all behind SRO_HDR', () => {
    expect(Object.keys(chunk.wgsl!).sort()).toEqual(Object.keys(chunk.glsl!).sort())
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const [point, code] of Object.entries(chunk[lang]!)) {
        expect(code.startsWith('#ifdef SRO_HDR\n'), `${lang} ${point}`).toBe(true)
        expect(balanced(code), `${lang} ${point}`).toBe(true)
        if (lang === 'wgsl') {
          expect(code, point).not.toMatch(/\b(float|vec[234]|ivec[234]|texture2D|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/)
          expect(code, point).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
          expect(code, point).not.toMatch(/\b(dpd[xy]\w*|fwidth\w*|textureSample(Bias|Compare)?)\s*\(/)
        } else {
          expect(code, point).not.toMatch(/\b(fn|let)\s|vec[234]f\(|var<private>|fragmentInputs|vertexOutputs|uniforms\./)
        }
      }
    }
    // Every uniform the chunks declare is in the ShaderMaterial list; the depth sampler is the only sampler.
    expect(chunk.uniforms).toEqual(GRASS_RENDER_UNIFORMS)
    expect(chunk.samplers).toEqual([GRASS_SHADOW_SAMPLER])
    expect(WORLD_SHADER_CHUNKS.at(-1)).toBe(RENDER_GRASS_CHUNKS) // render is last at every point
  })

  it('build into the grass shaders after the other lanes, and the vertex tap is a comparison sample', () => {
    const g = scatterShaders(WORLD_SHADER_CHUNKS)
    expect(g.vertexWGSL).toContain('textureSampleCompareLevel(rgShadowMap')
    expect(g.vertexWGSL).toContain('var rgShadowMapSampler: sampler_comparison;')
    expect(g.vertexGLSL).toContain('uniform highp sampler2DArrayShadow rgShadowMap;')
    // The HDR colour replaces the display colour last, before HEAD's (then switched off) linear fog.
    for (const f of [g.fragmentWGSL, g.fragmentGLSL]) {
      const hdr = f.indexOf('#ifdef SRO_HDR\n  {')
      expect(hdr).toBeGreaterThan(f.indexOf('SRO_NIGHT_GRASS'))
      expect(hdr).toBeLessThan(f.indexOf('fogParams.z > 0.5'))
    }
    // The TAA jitter moves the clip position (D30).
    expect(g.vertexWGSL).toContain('uniforms.rgJitter.xy * vertexOutputs.position.w')
    expect(g.vertexGLSL).toContain('gl_Position.xy += rgJitter.xy * gl_Position.w')
  })

  it('share the terrain\'s lightmap floor and D16\'s baked weight', () => {
    expect(GRASS_LIGHTMAP_FLOOR).toBe(TERRAIN_LIGHTMAP_FLOOR)
    expect(GRASS_BAKED_MIN).toBe(BAKED_MIN)
    for (const d of [BAKED_LIGHT_DIR, new Vector3(-1, 1, 0).normalize(), new Vector3(0, 1, 0), new Vector3(0.3, 0.2, 0.9).normalize()]) {
      expect(grassBakedWeight(d)).toBeCloseTo(bakedWeight(d), 12)
    }
  })

  it('the SH ambient equals the lighting\'s irradiance / π × the environment intensity', () => {
    const sh = new Float32Array([0.5, 0.6, 0.9, 0.2, 0.25, 0.4, 0.05, 0.02, 0.01, -0.03, 0.04, 0.02])
    const env = 0.58
    const s = grassSH(sh, env)
    for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.6, 0.8, 0]] as const) {
      const e = shIrradiance(sh, n[0], n[1], n[2])
      for (let c = 0; c < 3; c++) {
        const v = Math.max(0, s[c]! + s[3 + c]! * n[1] + s[6 + c]! * n[2] + s[9 + c]! * n[0])
        expect(v).toBeCloseTo((e[c]! / Math.PI) * env, 6)
      }
    }
    expect(wrappedNdotL(1)).toBe(1)
    expect(wrappedNdotL(-0.4)).toBe(0)
    expect(wrappedNdotL(0)).toBeCloseTo(0.4 / 1.4, 9)
  })

  it('the HDR colour keeps the earlier chunks: wet darkening multiplies, lamp light adds at 1 / exposure', () => {
    const base = 0.6, ref = 0.45, light = 0.3, inv = 1 / 8
    const lit = grassHdr(ref, ref, base, light, inv)
    expect(lit).toBeCloseTo(Math.pow(base, 2.2) * light, 9)
    expect(grassHdr(ref * 0.775, ref, base, light, inv)).toBeCloseTo(lit * 0.775, 9) // wet grass (WX-R)
    const splat = 0.2 // NL's night splat, display light
    expect(grassHdr(ref + splat, ref, base, light, inv)).toBeCloseTo(lit + Math.pow(splat, 2.2) * inv, 9)
    // × exposure the splat is the display light it was on Low, whatever the sun does.
    expect(grassHdr(ref + splat, ref, base, 0, inv) * 8).toBeCloseTo(Math.pow(splat, 2.2), 9)
  })
})

describe('RenderGrass', () => {
  function fakeTarget() {
    const defines = new Set<string>()
    const depth = new Map<string, (() => RenderTargetTexture | null) | null>()
    let ownFog = false
    const target: GrassTarget = {
      sharedUniforms: new SharedUniforms(),
      setDefine: (n, on) => { if (on) defines.add(n); else defines.delete(n) },
      setDepthTexture: (n, get) => { depth.set(n, get) },
      setOwnFog: off => { ownFog = off },
    }
    return { target, defines, depth, fog: () => ownFog }
  }

  function fakeSource(scene: Scene, mode: 'classic' | 'pbr', quality: Readonly<RenderQuality>, shadows: object | null = null) {
    const sky = {
      keyLight: { dir: new Vector3(0.3, 0.9, -0.2), color: [1, 0.95, 0.9], intensity: 0.43 },
      ambient: { sky: [0.05, 0.08, 0.15], horizon: [0.06, 0.07, 0.08], ground: [0.02, 0.02, 0.02] },
      sh: null,
      exposure: 7.7,
    } as unknown as SkyState
    const render = { mode, quality, weather: CLEAR_RENDER_WEATHER, taaJitter: new Vector2(0.001, -0.002), lighting: null, shadows: shadows as RenderPart | null, post: null, scene }
    return { render, sky: { state: sky } } satisfies GrassRenderSource
  }

  it('switches SRO_HDR and the own fog with the path, and nothing on the Classic path', () => {
    const scene = nullScene()
    const t = fakeTarget()
    const src = fakeSource(scene, 'classic', RENDER_PRESETS.low)
    const g = new RenderGrass(t.target, src)
    g.update()
    expect(t.defines.size).toBe(0)
    expect(t.fog()).toBe(false)
    expect(t.depth.size).toBe(0) // no depth binding (no bind observer) on the Classic path
    ;(src.render as { mode: string }).mode = 'pbr'
    src.render.quality = RENDER_PRESETS.medium
    g.update()
    expect([...t.defines]).toEqual([GRASS_HDR_DEFINE])
    expect(t.fog()).toBe(true)
    // Uniforms are bound once, by reference: the per-frame values change inside the same objects.
    const sun = t.target.sharedUniforms.get('rgSun')
    expect(sun).toBe(g.sun)
    expect(g.sun.y).toBeCloseTo(0.9 / Math.hypot(0.3, 0.9, -0.2), 6)
    expect(g.sun.w).toBe(MATERIAL_CLASS_PARAMS.foliage.translucency)
    expect(g.misc.z).toBeCloseTo(1 / 7.7, 6)
    expect([g.jitter.x, g.jitter.y]).toEqual([0.001, -0.002])
    for (const n of GRASS_RENDER_UNIFORMS) expect(t.target.sharedUniforms.has(n), n).toBe(true)
    g.dispose()
    expect(t.defines.size).toBe(0)
    expect(t.fog()).toBe(false)
    expect(t.target.sharedUniforms.size).toBe(0)
  })

  it('turns the root CSM tap on only on High+ with a PCF cascaded map, and binds its matrices by reference', () => {
    const scene = nullScene()
    const map = {} as RenderTargetTexture
    const mats = [Matrix.Identity(), Matrix.Translation(1, 0, 0), Matrix.Translation(2, 0, 0)]
    const gen = { numCascades: 3, shadowMaxZ: 150, usePercentageCloserFiltering: true, getShadowMap: () => map, getCascadeTransformMatrix: (i: number) => mats[i] ?? null, getDarkness: () => 0 }
    const shadows = { generator: gen }
    const t = fakeTarget()
    const src = fakeSource(scene, 'pbr', RENDER_PRESETS.medium, shadows)
    const g = new RenderGrass(t.target, src)
    g.update()
    expect(t.defines.has(GRASS_CSM_DEFINE)).toBe(false) // Medium: no root tap
    expect(g.misc.y).toBe(0)
    src.render.quality = RENDER_PRESETS.high
    g.update()
    expect(t.defines.has(GRASS_CSM_DEFINE)).toBe(true)
    expect(g.misc.y).toBe(150)
    expect(g.csmInfo.x).toBe(3)
    expect(t.target.sharedUniforms.get('rgCsm1')).toBe(mats[1])
    expect(t.depth.get(GRASS_SHADOW_SAMPLER)!()).toBe(map)
    // A non-PCF map (no depth texture) or no generator: the tap goes away.
    gen.usePercentageCloserFiltering = false
    g.update()
    expect(t.defines.has(GRASS_CSM_DEFINE)).toBe(false)
    expect(t.depth.get(GRASS_SHADOW_SAMPLER)).toBeNull()
  })
})

// ---- T12-W: the wave-12 tree chunks (SRO_FOL_VDATA, SRO_FOL_BAND; docs/TREES.md §W3.3–§W3.5, WF9) ------------------

/** A minimal preprocessor over the plugin's own #ifdef / #ifndef / #if defined(…) || … / #else / #endif lines. */
function preprocessOn(code: string, on: ReadonlySet<string>): string {
  const out: string[] = []
  const stack: Array<{ parent: boolean; cond: boolean }> = []
  let keep = true
  for (const line of code.split('\n')) {
    let m: RegExpExecArray | null
    if ((m = /^#(ifdef|ifndef)\s+(\w+)\s*$/.exec(line))) {
      const cond = (m[1] === 'ifdef') === on.has(m[2]!)
      stack.push({ parent: keep, cond })
      keep = keep && cond
    } else if ((m = /^#if\s+(.*)$/.exec(line))) {
      const cond = m[1]!.split('||').some(t => on.has(/defined\((\w+)\)/.exec(t)?.[1] ?? ''))
      stack.push({ parent: keep, cond })
      keep = keep && cond
    } else if (/^#else\b/.test(line)) {
      const top = stack[stack.length - 1]!
      top.cond = !top.cond
      keep = top.parent && top.cond
    } else if (/^#endif\b/.test(line)) {
      keep = stack.pop()!.parent
    } else if (keep) out.push(line)
  }
  expect(stack).toEqual([])
  return out.join('\n')
}

/** The right-hand side of `let name = …;` (WGSL) or `float name = …;` (GLSL) in the tree world-position code. */
function rhs(lang: 'wgsl' | 'glsl', name: string): string {
  const code = treeFoliageCode('vertex', lang).CUSTOM_VERTEX_UPDATE_WORLDPOS!
  const re = new RegExp(`^\\s*(?:let|float|int|vec[234]) ${name} = (.*);$`, 'm')
  const m = re.exec(code)
  expect(m, `${lang} ${name}`).not.toBeNull()
  return m![1]!
}

/** A shader scalar expression of the VDATA chunk as a JS function of the named inputs (the TS-mirror check). */
function evalExpr(expr: string): (v: Record<string, number>) => number {
  const js = expr
    .replace(/dot\(worldPos\.xyz, vec3f?\(1\.7, 2\.3, 1\.1\)\)/g, 'v.pd')
    .replace(/(uniforms\.)?wxB\.w/g, 'v.t')
    .replace(/folTw\.x/g, 'v.flex').replace(/folTw\.y/g, 'v.phase').replace(/folTw\.z/g, 'v.flutter')
    .replace(/folWd\.x/g, 'v.sway').replace(/\bfolH\b/g, 'v.h').replace(/\bfolZ\b/g, 'v.z').replace(/\bfolA\b/g, 'v.A')
    .replace(/\bsin\(/g, 'Math.sin(')
  expect(js, expr).not.toMatch(/\b(fol\w+|uniforms|vertexInputs|vec\w*)\b/)
  const fn = new Function('v', 'clamp', `return ${js}`) as (v: Record<string, number>, c: (x: number, a: number, b: number) => number) => number
  const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
  return v => fn(v, clamp)
}

/** A seeded random in [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('T12-W: the tree chunks (SRO_FOL_VDATA, SRO_FOL_BAND)', () => {
  it('ship the same keys in both languages, at points of the PBR shaders, each language to itself', () => {
    for (const stage of ['vertex', 'fragment'] as const) {
      const wgsl = treeFoliageCode(stage, 'wgsl')
      const glsl = treeFoliageCode(stage, 'glsl')
      expect(Object.keys(wgsl).sort()).toEqual(Object.keys(glsl).sort())
      expect(Object.keys(wgsl).sort()).toEqual(Object.keys(foliageCode(stage, 'wgsl')).sort())
      for (const [point, code] of Object.entries(wgsl)) {
        expect(balanced(code), `wgsl ${point}`).toBe(true)
        expect(code, point).not.toMatch(GLSL_IN_WGSL)
        expect(code, point).not.toMatch(/\?[^:]*:/)
        expect(code, point).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
      }
      for (const [point, code] of Object.entries(glsl)) {
        expect(balanced(code), `glsl ${point}`).toBe(true)
        expect(code, point).not.toMatch(WGSL_IN_GLSL)
      }
    }
    // The vertex reads the normal it flutters along, which both PBR vertex shaders have at the world-position point.
    expect(pbrSources('wgsl', 'vertex')).toContain('vertexOutputs.vNormalW')
    expect(pbrSources('glsl', 'vertex')).toMatch(/\bvNormalW\b/)
    for (const lang of ['wgsl', 'glsl'] as const) {
      const v = Object.values(treeFoliageCode('vertex', lang)).join('\n')
      for (const n of ['SRO_FOL_VDATA', 'SRO_FOL_BAND', 'folTw', 'folBand', TREE_BAND_SAMPLER, FOLIAGE_TREEW_KIND]) expect(v, `${lang} ${n}`).toContain(n)
      // The band texture is a vertex texture read without filtering: never sampled, never in the fragment.
      expect(v).toMatch(lang === 'wgsl' ? /textureLoad\(sroTreeBand,/ : /texelFetch\(sroTreeBand,/)
      expect(Object.values(treeFoliageCode('fragment', lang)).join('\n')).not.toMatch(/sroTreeBand|sroTreeW|SRO_FOL_(VDATA|BAND)/)
    }
  })

  it('the TS mirror of the bend and the flutter is the shader maths, in both languages', () => {
    const r = rng(12)
    for (const lang of ['wgsl', 'glsl'] as const) {
      const A = evalExpr(rhs(lang, 'folA'))
      const B = evalExpr(rhs(lang, 'folB'))
      const F = evalExpr(rhs(lang, 'folF'))
      for (let i = 0; i < 400; i++) {
        const v = { flex: r(), phase: r(), flutter: r(), sway: r() * 3 - 1, h: r() * FOLIAGE_MAX_H, z: r(), t: r() * 1000, pd: r() * 200 - 100, A: 0 }
        v.A = A(v)
        expect(v.A, `${lang} A`).toBeCloseTo(treeWindAmp(v.h), 9)
        expect(B(v), `${lang} bend`).toBeCloseTo(treeWindBend(v.flex, v.phase, v.h, v.z, v.t, v.sway), 7)
        expect(F(v), `${lang} flutter`).toBeCloseTo(treeFlutter(v.flutter, v.phase, v.z, v.t, v.pd), 7)
      }
    }
    // §W3.5: A is 1.2 m for a ≥ 10 m crown, ≈ 0.25 m for a 2 m plant; the root (flex 0) never moves.
    expect(treeWindAmp(14)).toBeCloseTo(TREE_W_AMP_M, 9)
    expect(treeWindAmp(2)).toBeGreaterThan(0.2)
    expect(treeWindAmp(2)).toBeLessThan(0.3)
    expect(Math.abs(treeWindBend(0, 0.3, 5, 1, 7, 1.5))).toBe(0)
    expect(Math.abs(treeFlutter(0, 0.3, 1, 7, 2))).toBe(0)
    // The limbs lag each other: two phases a quarter turn apart sway differently at one instant.
    expect(Math.abs(treeWindBend(1, 0, 12, 1, 1, 0) - treeWindBend(1, 0.25, 12, 1, 1, 0))).toBeGreaterThan(0.5)
    // Calm air (the minimum breeze, 0.15) still sways a crown tip by centimetres; a storm by about a metre or more.
    const peak = (s: number) => Math.max(...Array.from({ length: 200 }, (_, k) => Math.abs(treeWindBend(1, 0, 12, s, k * 0.05, 0))))
    expect(peak(0.15)).toBeGreaterThan(0.1)
    expect(peak(0.15)).toBeLessThan(0.3)
    expect(peak(1)).toBeGreaterThan(1)
    // A 2 m reed's tip in a storm with the gust: ≈ 0.3–1 m, the retail clips' range (BT-T).
    const reed = Math.max(...Array.from({ length: 200 }, (_, k) => Math.abs(treeWindBend(1, 0, 2, 1, k * 0.05, 1.5))))
    expect(reed).toBeGreaterThan(0.3)
    expect(reed).toBeLessThan(1)
  })

  it('the band texel and the show rule are the shader\'s (slot × 4 + tier; tier 0 always shows)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = treeFoliageCode('vertex', lang).CUSTOM_VERTEX_UPDATE_WORLDPOS!
      expect(code).toContain(`folSlot % ${TREE_BAND_TEX_W}, folSlot / ${TREE_BAND_TEX_W}`)
      expect(code).toMatch(lang === 'wgsl' ? /folTier = folBw & 3u;/ : /folTier = folBw & 3;/)
      expect(code).toMatch(lang === 'wgsl' ? /folSlot = i32\(folBw >> 2u\);/ : /folSlot = folBw >> 2;/)
      expect(code).toMatch(lang === 'wgsl' ? /if \(folTier != 0u\) \{/ : /if \(folTier != 0\) \{/)
      expect(code).toContain('if (folBand != folTier) {')
      expect(code).toContain('* 255.0')
    }
    expect(treeBandTexel(0)).toEqual([0, 0])
    expect(treeBandTexel(TREE_BAND_TEX_W + 3)).toEqual([3, 1])
    expect(treeBandTexel(TREE_BAND_TEX_W * TREE_BAND_TEX_H - 1)).toEqual([TREE_BAND_TEX_W - 1, TREE_BAND_TEX_H - 1])
    for (const band of [0, 1, 2, 3]) {
      expect(treeBandShows(7 * 4 + 0, band)).toBe(true)
      expect(treeBandShows(7 * 4 + 1, band)).toBe(band === 1)
      expect(treeBandShows(7 * 4 + 2, band)).toBe(band === 2)
    }
  })

  it('the collapse leaves zero-area triangles at the root and the shown tier untouched', () => {
    // One tree (slot 5, root (10, 2, -4)) merged with LOD1 (tier 1) and LOD2 (tier 2) triangles, and a retail tree (tier 0).
    const root = [10, 2, -4]
    const tris = [
      { word: 5 * 4 + 1, p: [[9, 3, -4], [11, 3, -4], [10, 8, -3]] },
      { word: 5 * 4 + 2, p: [[8, 3, -5], [12, 3, -3], [10, 9, -4]] },
      { word: 0, p: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
    ]
    const area = (p: number[][]) => {
      const a = p[1]!.map((x, i) => x - p[0]![i]!)
      const b = p[2]!.map((x, i) => x - p[0]![i]!)
      const c = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
      return Math.hypot(c[0]!, c[1]!, c[2]!) / 2
    }
    for (const band of [0, 1, 2, 3]) {
      for (const t of tris) {
        const shows = treeBandShows(t.word, band)
        const moved = t.p.map(v => (shows ? v : root))
        if (shows) expect(area(moved)).toBeCloseTo(area(t.p), 9)
        else expect(area(moved)).toBe(0)
      }
      // Exactly one merged tier of the tree shows in bands 1 and 2, none in 0 (the overlay's LOD0) and 3 (hidden).
      const shown = tris.slice(0, 2).filter(t => treeBandShows(t.word, band)).length
      expect(shown).toBe(band === 1 || band === 2 ? 1 : 0)
    }
    // The shader moves the vertex to the pivot's root (the same for every vertex of the tree) and moves vPositionW too.
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = treeFoliageCode('vertex', lang).CUSTOM_VERTEX_UPDATE_WORLDPOS!
      expect(code).toContain(lang === 'wgsl' ? `(finalWorld * vec4f(vertexInputs.${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz` : `(finalWorld * vec4(${FOLIAGE_PIVOT_KIND}.xyz, 1.0)).xyz`)
      expect(code).toContain(lang === 'wgsl' ? 'worldPos = vec4f(folBr, worldPos.w);' : 'worldPos = vec4(folBr, worldPos.w);')
      expect(code).toContain(lang === 'wgsl' ? 'vertexOutputs.vPositionW = folBr;' : 'vPositionW = folBr;')
    }
  })

  it('BAND runs with the weather absent and with the wind off (WF9): the vec4 pivot, the sampler, the collapse', async () => {
    // The preprocessed code with only BAND and PIVOT4 on (no wind, no flutter): no moving block, the band block there.
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = treeFoliageCode('vertex', lang)
      const on = new Set(['SRO_FOL_BAND', 'SRO_FOL_PIVOT4'])
      const defs = preprocessOn(code.CUSTOM_VERTEX_DEFINITIONS!, on)
      expect(defs.split('\n').filter(l => l.startsWith('attribute') && l.includes(FOLIAGE_PIVOT_KIND))).toHaveLength(1)
      expect(defs).toContain(lang === 'wgsl' ? `${FOLIAGE_PIVOT_KIND}: vec4f` : `vec4 ${FOLIAGE_PIVOT_KIND}`)
      expect(defs).toContain(TREE_BAND_SAMPLER)
      expect(defs).not.toContain('sroWind')
      const pos = preprocessOn(code.CUSTOM_VERTEX_UPDATE_WORLDPOS!, on)
      expect(pos).toContain('folBand')
      expect(pos).not.toContain('folO')
      // And with the wind on and VDATA: the VDATA bend replaces the h² bend (no folH² term, one flutter).
      const all = preprocessOn(code.CUSTOM_VERTEX_UPDATE_WORLDPOS!, new Set(['SRO_FOL_WIND', 'SRO_FOL_FLUTTER', 'SRO_FOL_PIVOT', 'SRO_FOL_PIVOT4', 'SRO_FOL_VDATA', 'SRO_FOL_BAND', 'NORMAL']))
      expect(all).not.toContain('folH * folH')
      expect(all.match(/folWd = sroWind/g)).toHaveLength(1)
      expect(all.match(/folF = /g)).toHaveLength(1)
      expect(all.indexOf('folBand')).toBeGreaterThan(all.indexOf('folO'))
    }

    const scene = nullScene()
    const shared = new FoliageShared()
    Object.assign(shared, { active: true, wind: false, translucency: true, u: null })
    const mat = new PBRMaterial('batch:tree:leaf', scene)
    new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage', baked: true })
    const p = new SroFoliagePlugin(mat, shared, { leaf: true, kind: 'static', tree: true, breeze: 0.15, shadowWrapper: false })
    const mesh = boxWith(scene, mat)
    const n = mesh.getTotalVertices()
    mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * TREE_PIVOT_FLOATS).fill(1), false, TREE_PIVOT_FLOATS)
    mesh.setVerticesData(FOLIAGE_TREEW_KIND, new Float32Array(n * 4).fill(0.5), false, 4)
    const defs = () => {
      const d = {} as Record<string, boolean>
      p.prepareDefines(d as never, scene, mesh)
      const attrs: string[] = []
      p.getAttributes(attrs, scene, mesh)
      return { d, attrs }
    }
    // No band texture yet (no trees part): BAND off, nothing banded to collapse.
    let r = defs()
    expect([r.d.SRO_FOL_BAND, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_WIND]).toEqual([false, false, false])
    // The band texture set: BAND and the vec4 pivot with no weather vectors and the wind off.
    const band = RawTexture.CreateRTexture(new Uint8Array(TREE_BAND_TEX_W * TREE_BAND_TEX_H), TREE_BAND_TEX_W, TREE_BAND_TEX_H, scene)
    shared.setBand(band)
    r = defs()
    expect([r.d.SRO_FOL_BAND, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_PIVOT, r.d.SRO_FOL_WIND]).toEqual([true, true, false, false])
    expect(r.attrs).toContain(FOLIAGE_PIVOT_KIND)
    // Wind on with the weather: the same BAND, now with the pivot read by the bend too.
    shared.u = WIND
    shared.wind = true
    r = defs()
    expect([r.d.SRO_FOL_BAND, r.d.SRO_FOL_PIVOT4, r.d.SRO_FOL_PIVOT, r.d.SRO_FOL_VDATA]).toEqual([true, true, true, true])
    expect(r.attrs.filter(a => a === FOLIAGE_PIVOT_KIND)).toHaveLength(1)
    // The effect waits for the band texture, and the bind sets it only on a banded sub-mesh.
    expect(p.isReadyForSubMesh({ SRO_FOL_BAND: true } as never)).toBe(band.isReady())
    expect(p.isReadyForSubMesh({ SRO_FOL_BAND: false } as never)).toBe(true)
    const set: string[] = []
    const ubo = { updateFloat4: () => {}, setTexture: (name: string) => set.push(name) } as unknown as UniformBuffer
    p.bindForSubMesh(ubo, scene, scene.getEngine(), { materialDefines: { SRO_FOL_BAND: true } } as unknown as SubMesh)
    p.bindForSubMesh(ubo, scene, scene.getEngine(), { materialDefines: { SRO_FOL_BAND: false } } as unknown as SubMesh)
    expect(set).toEqual([TREE_BAND_SAMPLER])
    // The band cleared: off again; a plugin that is not a tree's never declares or binds it.
    shared.setBand(null)
    expect(defs().d.SRO_FOL_BAND).toBe(false)
    const plain = new PBRMaterial('tre_leaf', scene)
    new SroSurfacePlugin(plain, new SurfaceShared(), { cls: 'foliage' })
    const other = new SroFoliagePlugin(plain, shared, { leaf: true, kind: 'static' })
    shared.setBand(band)
    const od = {} as Record<string, boolean>
    other.prepareDefines(od as never, scene, mesh)
    expect([od.SRO_FOL_BAND, od.SRO_FOL_PIVOT4]).toEqual([false, false])
    const samplers: string[] = []
    other.getSamplers(samplers)
    expect(samplers).toEqual([])
    // On the NullEngine the banded tree material compiles and is ready.
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_FOL_BAND).toBe(true)
  })

  it('setBand re-prepares only the tree plugins, and only when the band switches on or off', () => {
    const scene = nullScene()
    const shared = new FoliageShared()
    const tree = new SroFoliagePlugin(new PBRMaterial('t', scene), shared, { leaf: true, kind: 'static', tree: true })
    const leaf = new SroFoliagePlugin(new PBRMaterial('l', scene), shared, { leaf: true, kind: 'static' })
    let tDirty = 0
    let lDirty = 0
    ;(tree as unknown as { markAllDefinesAsDirty: () => void }).markAllDefinesAsDirty = () => void tDirty++
    ;(leaf as unknown as { markAllDefinesAsDirty: () => void }).markAllDefinesAsDirty = () => void lDirty++
    const a = RawTexture.CreateRTexture(new Uint8Array(4), 2, 2, scene)
    const b = RawTexture.CreateRTexture(new Uint8Array(4), 2, 2, scene)
    shared.setBand(a)
    shared.setBand(a)
    shared.setBand(b)
    expect([tDirty, lDirty]).toEqual([1, 0])
    expect(shared.band).toBe(b)
    shared.setBand(null)
    expect([tDirty, lDirty]).toEqual([2, 0])
  })

  it('the tree group declares every UBO member and sampler once (surface + tree foliage + fog), in GLSL and WGSL', () => {
    const scene = nullScene()
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    const mat = new PBRMaterial('batch:tree:leaf', scene)
    new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage', baked: true, table: { albedo: tex, nrao: tex, lightmap: tex, table: tex } })
    new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static', tree: true, breeze: 0.15, shadowWrapper: false })
    attachFogPlugin(mat, new HeightFog(scene))
    const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const m = mat as unknown as { _shaderLanguage: ShaderLanguage; buildUniformLayout(): void }
      const was = m._shaderLanguage
      m._shaderLanguage = lang
      try {
        m.buildUniformLayout()
      } finally {
        m._shaderLanguage = was
      }
      const pm = mat.pluginManager as unknown as { _uboDeclaration: string; _samplerList: string[] }
      const members = pm._uboDeclaration.split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => /^uniform\s+(\w+)\s*:/.exec(l)?.[1] ?? /^\w+\s+(\w+)/.exec(l)?.[1] ?? l)
      expect(dupes(members), `${lang}`).toEqual([])
      expect(dupes(pm._samplerList), `${lang}`).toEqual([])
      expect(pm._samplerList.filter(s => s === TREE_BAND_SAMPLER)).toHaveLength(1)
    }
  })
})
