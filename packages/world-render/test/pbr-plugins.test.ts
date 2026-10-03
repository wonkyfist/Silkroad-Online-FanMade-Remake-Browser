/**
 * SroSurfacePlugin and the PbrSurfaces part (pbr/surface-plugin.ts; docs/RENDER.md §3.5, docs/WAVE_PLAN3.md §6.10,
 * D16, D19, D28, D31; DETAIL H3/H4/H6): WGSL and GLSL return the same injection-point keys, every key is a point of
 * Babylon 9.28's PBR fragment in both languages and the code only names variables those shaders have, no GLSL idiom
 * leaks into the WGSL; the defines follow the lightmap, the weather level and the enable switch; a NullEngine
 * PBRMaterial with the plugin is ready; the tier rule; the D16 baked weight; the character decorator keeps the Classic
 * path untouched and dresses characters on PBR.
 */
import { MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, ShaderStore, Vector3, Vector4, type Mesh } from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BAKED_LIGHT_DIR,
  CLEAR_RENDER_WEATHER,
  LAMP_EMISSIVE,
  PbrSurfaces,
  RENDER_PRESETS,
  SKIN_IOR,
  SKY_CLOUD_SHADOW_UBO,
  SRO_SURFACE_PLUGIN,
  SURFACE_UNIFORMS,
  SroSurfacePlugin,
  SurfaceShared,
  WEATHER_PRESETS,
  WX_SHELTER_UNIFORMS,
  WX_SHELTER_WGSL,
  bakedWeight,
  materialTier,
  surfaceFragmentCode,
  surfacePluginOf,
  type ShelterMap,
  type SkyState,
  type SurfaceWeatherSource,
  type WeatherUniforms,
} from '../src/index.ts'

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

/** The PBR fragment of one language with every include appended (the texts the injection points live in). */
function pbrSources(lang: 'wgsl' | 'glsl'): string {
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL.pbrPixelShader : ShaderStore.ShadersStore.pbrPixelShader
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  expect(main, `pbr fragment (${lang})`).toBeTruthy()
  return [main, ...Object.values(includes)].join('\n')
}

describe('surface plugin code', () => {
  it('ships the same injection points in WGSL and GLSL, each a PBR fragment point in both languages', () => {
    const wgsl = surfaceFragmentCode('wgsl')
    const glsl = surfaceFragmentCode('glsl')
    expect(Object.keys(wgsl).sort()).toEqual(Object.keys(glsl).sort())
    expect(Object.keys(wgsl).sort()).toEqual([
      'CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION',
      'CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR',
      'CUSTOM_FRAGMENT_DEFINITIONS',
      'CUSTOM_FRAGMENT_MAIN_BEGIN',
      'CUSTOM_FRAGMENT_UPDATE_ALBEDO',
      'CUSTOM_FRAGMENT_UPDATE_ALPHA',
      'CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS',
      'CUSTOM_LIGHT0_COLOR',
    ])
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrSources(lang)
      for (const point of Object.keys(wgsl)) {
        const define = point === 'CUSTOM_LIGHT0_COLOR' ? '#define CUSTOM_LIGHT{X}_COLOR' : `#define ${point}`
        expect(src.includes(define), `${lang} ${point}`).toBe(true)
      }
    }
  })

  it('only names variables the PBR fragment has, in both languages', () => {
    const names = ['surfaceAlbedo', 'metallicRoughness', 'normalW', 'geometricNormalW', 'lightmapColor', 'diffuse{X}', 'finalIrradiance',
      'finalAmbient', 'finalEmissive', 'specularEnvironmentR0', 'microSurface', 'vPositionW', 'vNormalW', 'vEyePosition']
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrSources(lang)
      for (const n of names) expect(src.includes(n), `${lang} ${n}`).toBe(true)
    }
  })

  it('has no GLSL idiom in the WGSL and no WGSL idiom in the GLSL; every #if is closed; all under SRO_SURFACE', () => {
    // BT-P: SRO_TABLE takes its six derivatives once, as the first statements of main (uniform control flow, before
    // clipPlane's discard and any branch); pbr-table.test.ts checks their place, abuse-w9f-uniformity the assembled WGSL.
    const tableDerivatives = /^ {2}(?:let \w+|sroT\w+) = dpd[xy]\((?:fragmentInputs\.vPositionW|sroUv2?)\);$/gm
    for (const [point, code] of Object.entries(surfaceFragmentCode('wgsl'))) {
      expect(code, point).not.toMatch(/\b(float|vec[234]|ivec[234]|texture2D|textureLod|dFdx|dFdy|gl_\w+)\s*[(\s]/)
      expect(code, point).not.toMatch(/\?[^:]*:/) // no ternary
      expect(code, point).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/) // no swizzle assignment
      const rest = point === 'CUSTOM_FRAGMENT_MAIN_BEGIN' ? code.replace(tableDerivatives, '') : code
      expect(rest, point).not.toMatch(/\b(dpd[xy]\w*|fwidth\w*|textureSample(Bias|Compare)?)\s*\(/) // no derivative or implicit-lod sample
    }
    for (const [point, code] of Object.entries(surfaceFragmentCode('glsl'))) {
      expect(code, point).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|var<private>|fragmentInputs|uniforms\./)
    }
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const [point, code] of Object.entries(surfaceFragmentCode(lang))) {
        const opens = (code.match(/^#if/gm) ?? []).length
        const closes = (code.match(/^#endif/gm) ?? []).length
        expect(opens, `${lang} ${point}`).toBe(closes)
        expect(code.startsWith('#ifdef SRO_SURFACE\n'), `${lang} ${point}`).toBe(true)
      }
    }
  })
})

describe('tiers and the D16 baked weight', () => {
  it('materialTier follows the terrain detail flags of the preset', () => {
    expect(materialTier(RENDER_PRESETS.low)).toBe('classic')
    expect(materialTier(RENDER_PRESETS.medium)).toBe('medium')
    expect(materialTier(RENDER_PRESETS.high)).toBe('high')
    expect(materialTier(RENDER_PRESETS.ultra)).toBe('ultra')
    // An Advanced row (SSAO off on High) keeps High's materials.
    expect(materialTier({ ...RENDER_PRESETS.high, ssao: null })).toBe('high')
  })

  it('is 1 at the bake direction and never below 0.35', () => {
    expect(bakedWeight(BAKED_LIGHT_DIR)).toBe(1)
    expect(bakedWeight(new Vector3(-1, 1, 0).normalize())).toBe(0.35)
    expect(bakedWeight(new Vector3(0, 1, 0))).toBeCloseTo(Math.max(0.35, BAKED_LIGHT_DIR.y * 2 - 0.6), 6)
  })
})

function boxWith(scene: Scene, mat: PBRMaterial): Mesh {
  const box = MeshBuilder.CreateBox('b', { size: 1 }, scene)
  box.material = mat
  return box
}

const definesOf = (mesh: Mesh) => mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>

/** Prepares the defines and waits for the (NullEngine) effect: the first call compiles, a later one is ready. */
async function ready(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material as PBRMaterial
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId() // a new frame: the defines are re-checked
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

describe('SroSurfacePlugin on a NullEngine PBRMaterial', () => {
  it('is ready, found by name (D19), and its defines follow the class, the lightmap and the weather', async () => {
    const scene = nullScene()
    const shared = new SurfaceShared()
    const mat = new PBRMaterial('wall', scene)
    const plugin = new SroSurfacePlugin(mat, shared, { cls: 'stone', baked: true })
    expect(mat.pluginManager!.getPlugin(SRO_SURFACE_PLUGIN)).toBe(plugin)
    expect(surfacePluginOf(mat)).toBe(plugin)
    const mesh = boxWith(scene, mat)
    expect(await ready(mesh)).toBe(true)
    expect(mat.isReady(mesh)).toBe(true)
    let d = definesOf(mesh)
    expect([d.SRO_SURFACE, d.SRO_LUMA_ROUGH, d.SRO_BAKED, d.SRO_WET]).toEqual([true, true, false, false]) // no lightmap yet

    // An object lightmap: baked visibility, Babylon's multiply and gamma decode off.
    const lm = RawTexture.CreateRGBATexture(new Uint8Array([200, 200, 200, 255]), 1, 1, scene)
    lm.coordinatesIndex = 1
    lm.getInternalTexture()!.isReady = true // NullEngine never uploads
    mat.lightmapTexture = lm
    mat.useLightmapAsShadowmap = true
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.LIGHTMAP, d.SRO_BAKED, d.LIGHTMAPEXCLUDED, d.GAMMALIGHTMAP]).toEqual([true, true, true, false])

    // The weather level switches wetness for every plugin at once.
    shared.wet = true
    shared.puddles = true
    shared.dirtyAll()
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.SRO_WET, d.SRO_PUDDLES, d.SRO_SHELTER]).toEqual([true, true, false]) // no shelter map at this level

    // A shelter map (D20): WX-R's sroShelter runs, WX_OCC8 for an RGBA8 map; its uniforms are in the plugin's UBO.
    const occ = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    occ.getInternalTexture()!.isReady = true
    shared.shelter = { texture: occ, packed: true } as unknown as ShelterMap
    shared.dirtyAll()
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    const shipped = WX_SHELTER_WGSL.trim() !== ''
    expect([d.SRO_SHELTER, d.WX_OCC8]).toEqual([shipped, shipped])
    for (const n of [...WX_SHELTER_UNIFORMS, ...SKY_CLOUD_SHADOW_UBO.map(u => u.name)]) expect(SURFACE_UNIFORMS).toContain(n)

    plugin.roughnessMap = true
    plugin.refresh()
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_LUMA_ROUGH).toBe(false)

    plugin.isEnabled = false
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.SRO_SURFACE, d.SRO_BAKED, d.SRO_WET]).toEqual([false, false, false])
  })

  it('carries the class numbers: porosity, wet roughness, puddles; metal is in the SSR mask', () => {
    const scene = nullScene()
    const shared = new SurfaceShared()
    const soil = new SroSurfacePlugin(new PBRMaterial('a', scene), shared, { cls: 'ground_soil' })
    expect(soil.surf.asArray()).toEqual([0.1, 0.6, 0.2, 1])
    const metal = new SroSurfacePlugin(new PBRMaterial('b', scene), shared, { cls: 'metal', porosity: 0.2 })
    expect([metal.surf.y, metal.ssr]).toEqual([0.2, 1])
    expect(shared.plugins.size).toBe(2)
    soil.dispose()
    expect(shared.plugins.size).toBe(1)
    expect(LAMP_EMISSIVE).toBe(1.5)
  })
})

const SKY = {
  keyLight: { dir: BAKED_LIGHT_DIR.clone(), color: [1, 1, 1], intensity: 1 },
  night: 0.25,
  cloudShadow: null,
  cloudNoise: null,
} as unknown as SkyState

function weatherSource(level: keyof typeof WEATHER_PRESETS): SurfaceWeatherSource & { level: string } {
  const u = { wxOcc: new Vector4(), wxCam: new Vector4() } as unknown as WeatherUniforms
  return { level, preset: WEATHER_PRESETS[level], shelter: null, u }
}

describe('PbrSurfaces (the render part)', () => {
  it('feeds the shared state from the weather and the sky, only on the PBR path', () => {
    const scene = nullScene()
    const part = new PbrSurfaces(scene)
    const ws = weatherSource('medium')
    const host = { mode: 'classic' as const, quality: RENDER_PRESETS.low, weather: CLEAR_RENDER_WEATHER, materials: null as unknown }
    part.attach(host as never, ws)
    expect(host.materials).toBeNull() // the Classic path has no render part (the Low guard)
    part.setWeather({ ...CLEAR_RENDER_WEATHER, rain: 0.5, wetness: 0.7, puddles: 0.2, wind: 1, flash: 0.3 })
    expect(part.shared.weather.asArray()).toEqual([0.5, 0.7, 0.2, 1])
    expect(part.shared.flash).toBe(0.3)
    part.update(null, { ...SKY, keyLight: { ...SKY.keyLight, dir: new Vector3(-1, 1, 0).normalize() } })
    expect([part.shared.bakedK, part.shared.night, part.shared.wet]).toEqual([1, 0, false]) // Classic: untouched
    part.setMode('pbr')
    expect(host.materials).toBe(part)
    part.setQuality(RENDER_PRESETS.high)
    part.update(null, { ...SKY, keyLight: { ...SKY.keyLight, dir: new Vector3(-1, 1, 0).normalize() } })
    expect([part.shared.bakedK, part.shared.night, part.shared.wet, part.shared.puddles]).toEqual([0.35, 0.25, true, true])
    // Medium: wet, but no object puddles (RENDER §9.3: High+).
    part.setQuality(RENDER_PRESETS.medium)
    expect([part.shared.wet, part.shared.puddles]).toEqual([true, false])
    // TX-R: Medium loads the retail-size remaster (RenderQuality.textures absent = 'auto').
    expect(part.policy()).toEqual({ tier: 'remaster', albedoCap: 'retail', tier2x: false, mapCap: 'retail', maps: 'hero', ktx2: false, remasterCap: 1024 })
    part.setQuality({ ...RENDER_PRESETS.medium, textures: 'retail' })
    expect(part.policy().tier).toBe('retail')
  })

  it('leaves Classic characters alone and dresses them on PBR (class numbers, skin F0, cloth sheen on High+)', () => {
    const scene = nullScene()
    const part = new PbrSurfaces(scene)
    part.attach({ mode: 'classic', quality: RENDER_PRESETS.low, weather: CLEAR_RENDER_WEATHER, materials: null })
    const skin = new PBRMaterial('chinaman_adventurer_body', scene)
    skin.metallic = 0
    skin.roughness = 1
    const cloth = new PBRMaterial('clothes', scene)
    cloth.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    cloth.albedoTexture.name = 'clothes_01_ba'
    part.decorateCharacterMaterial(skin)
    part.decorateCharacterMaterial(cloth)
    part.decorateCharacterMaterial(skin) // idempotent
    expect(part.characterCount).toBe(2)
    expect([surfacePluginOf(skin), surfacePluginOf(cloth)]).toEqual([null, null])
    expect([skin.roughness, skin.subSurface.indexOfRefraction]).toEqual([1, 1.5])

    part.setQuality(RENDER_PRESETS.high)
    part.setMode('pbr')
    expect(surfacePluginOf(skin)!.cls).toBe('skin')
    expect(surfacePluginOf(cloth)!.cls).toBe('cloth')
    expect([skin.roughness, skin.subSurface.indexOfRefraction]).toEqual([0.55, SKIN_IOR])
    expect(skin.subSurface.isTranslucencyEnabled).toBe(false) // Ultra only
    expect(cloth.sheen.isEnabled).toBe(true)
    part.setQuality(RENDER_PRESETS.ultra)
    expect(skin.subSurface.isTranslucencyEnabled).toBe(true)
    part.setQuality(RENDER_PRESETS.medium)
    expect([cloth.sheen.isEnabled, skin.subSurface.isTranslucencyEnabled]).toEqual([false, false])

    part.setMode('classic')
    expect(part.shared.wet).toBe(false)
    expect(surfacePluginOf(skin)!.isEnabled).toBe(false)
    expect([skin.metallic, skin.roughness, skin.subSurface.indexOfRefraction]).toEqual([0, 1, 1.5])
    expect(cloth.sheen.isEnabled).toBe(false)
  })
})
