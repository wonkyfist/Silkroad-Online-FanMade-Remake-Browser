/**
 * PBR terrain plugin (docs/WAVE_PLAN3.md §6.11, D32; docs/RENDER.md §3.5, §6.2): both languages carry the same
 * injection points for every extern combination, no GLSL leaks into the WGSL code (and back), the define set follows
 * the preset / weather level / map arrays / lanes' defines, externs parse into UBO members and samplers, a NullEngine
 * PBRMaterial with the plugin compiles, and the WebGL2 texture units of every final define set stay ≤ 16.
 */
import { DirectionalLight, MeshBuilder, NullEngine, RawTexture, Scene, SphericalPolynomial, Vector3, Vector4, type Mesh, type PBRMaterial } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AO_POINT,
  NO_TERRAIN_FEATURES,
  SRO_TERRAIN_PLUGIN,
  TERRAIN_FEATURE_DEFINES,
  TERRAIN_FEATURES,
  TerrainPbr,
  defaultTerrainExterns,
  featureKey,
  makeDetailLayers,
  parseExtern,
  resolveTerrainFeatures,
  terrainClassTable,
  terrainPluginCode,
  type TerrainExterns,
  type TerrainFeatures,
} from '../src/pbr/terrain-plugin.ts'
import { MATERIAL_CLASS_PARAMS, TERRAIN_SURFACE, TERRAIN_SURFACE_PARAMS } from '../src/pbr/classes.ts'
import { RENDER_PRESETS, type RenderPreset } from '../src/render/quality.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { WEATHER_PRESETS, type WeatherLevel } from '../src/weather/presets.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Lane-shaped fake externs (the real WX-R / SKY-B sources are still empty): one texture and one vec4 each. */
const FAKE_EXTERNS: TerrainExterns = {
  shelter: parseExtern('sroShelter',
    'uniform wxOcc: vec4f;\nvar wxOccMap: texture_2d<f32>;\nvar wxOccMapSampler: sampler;\nfn sroShelter(p: vec3f) -> f32 {\n  return textureSampleLevel(wxOccMap, wxOccMapSampler, (p.xz - uniforms.wxOcc.xy) * uniforms.wxOcc.w + vec2f(0.5), 0.0).r;\n}\n',
    'uniform vec4 wxOcc;\nuniform sampler2D wxOccMap;\nfloat sroShelter(vec3 p) {\n  return textureLod(wxOccMap, (p.xz - wxOcc.xy) * wxOcc.w + vec2(0.5), 0.0).r;\n}\n'),
  cloudShadow: parseExtern('sroCloudShadow',
    'uniform skyCloud: vec4f;\nvar skyCloudNoise: texture_2d<f32>;\nvar skyCloudNoiseSampler: sampler;\nfn sroCloudShadow(xz: vec2f) -> f32 {\n  return 1.0 - textureSampleLevel(skyCloudNoise, skyCloudNoiseSampler, xz * uniforms.skyCloud.x, 0.0).r * uniforms.skyCloud.y;\n}\n',
    'uniform vec4 skyCloud;\nuniform sampler2D skyCloudNoise;\nfloat sroCloudShadow(vec2 xz) {\n  return 1.0 - textureLod(skyCloudNoise, xz * skyCloud.x, 0.0).r * skyCloud.y;\n}\n'),
  nightSplat: defaultTerrainExterns().nightSplat,
}

describe('shader code', () => {
  const combos: Array<[string, TerrainExterns]> = [
    ['lane defaults', defaultTerrainExterns()],
    ['fake externs', FAKE_EXTERNS],
    ['no externs', { shelter: null, cloudShadow: null, nightSplat: null }],
  ]

  it.each(combos)('WGSL and GLSL have the same injection points (%s)', (_name, x) => {
    const w = terrainPluginCode('wgsl', x)
    const g = terrainPluginCode('glsl', x)
    expect(Object.keys(w).sort()).toEqual(Object.keys(g).sort())
    expect(Object.keys(w)).toContain(AO_POINT)
    expect(Object.keys(w)).toContain('CUSTOM_LIGHT0_COLOR')
  })

  it('no GLSL in the WGSL code and no WGSL in the GLSL code', () => {
    const w = Object.values(terrainPluginCode('wgsl', FAKE_EXTERNS)).join('\n')
    const g = Object.values(terrainPluginCode('glsl', FAKE_EXTERNS)).join('\n')
    for (const bad of [/\bvec[234]\(/, /\bfloat\s+\w+\s*[=;(]/, /\bdFd[xy]\b/, /\btexture(Grad|Lod)?\(/, /\btexelFetch\b/, /\buniform\s+(highp\s+)?sampler/, /\?[^:]*:/]) {
      expect(w, String(bad)).not.toMatch(bad)
    }
    for (const bad of [/\bvec[234]f\b/, /\blet\s/, /var<private>/, /\bdpd[xy]\b/, /\btextureSample\w*\(/, /\bf32\b/, /uniforms\./]) {
      expect(g, String(bad)).not.toMatch(bad)
    }
  })

  it('every #ifdef is one of the plugin defines (or Babylon\'s prepass flag)', () => {
    const known = new Set([...Object.values(TERRAIN_FEATURE_DEFINES), 'PREPASS_REFLECTIVITY'])
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = Object.values(terrainPluginCode(lang, FAKE_EXTERNS)).join('\n')
      for (const m of code.matchAll(/#ifdef\s+(\w+)/g)) expect(known.has(m[1]!), `${lang} ${m[1]}`).toBe(true)
      expect(code.match(/#ifdef/g)!.length).toBe(code.match(/#endif/g)!.length)
    }
  })

  it('WGSL: every derivative and implicit-LOD tap comes before the layer loop (uniform control flow)', () => {
    const def = terrainPluginCode('wgsl', FAKE_EXTERNS).CUSTOM_FRAGMENT_DEFINITIONS!
    const body = def.slice(def.indexOf('fn sroTerrainEval()'))
    const loop = body.indexOf('for (var k = 0;')
    expect(loop).toBeGreaterThan(0)
    const after = body.slice(loop)
    expect(after).not.toMatch(/\b(dpd[xy]\w*|fwidth\w*|textureSample(Bias|Compare)?)\s*\(/)
    // The parallax loop sits before the layer loop and uses explicit gradients only (the lightmap's top-level
    // textureSampleBias is uniform; abuse-w9f-uniformity.test.ts checks the assembled WGSL for branches properly).
    expect(body.slice(0, loop).replace(/textureSampleGrad|textureSampleLevel/g, '')).not.toMatch(/\btextureSample\s*\(/)
  })

  it('the class table is RENDER §3.3 per surface class, with sand keeping WEATHER\'s porosity', () => {
    const t = terrainClassTable()
    expect(t).toHaveLength(6)
    expect(t[TERRAIN_SURFACE.grass]).toEqual([0.85, 0.45, 0.3, 0.35])
    expect(t[TERRAIN_SURFACE.stone]![0]).toBe(MATERIAL_CLASS_PARAMS.stone.roughness)
    expect(t[TERRAIN_SURFACE.sand]![1]).toBe(TERRAIN_SURFACE_PARAMS[TERRAIN_SURFACE.sand]!.porosity)
    expect(t[TERRAIN_SURFACE.water]![1]).toBe(0)
    expect(terrainPluginCode('wgsl').CUSTOM_FRAGMENT_DEFINITIONS).toContain('if (c == 1) { return vec4f(0.85, 0.45, 0.3, 0.35); }')
  })
})

describe('externs', () => {
  it('moves uniform lines into the UBO list and finds the samplers in both languages', () => {
    const e = FAKE_EXTERNS.shelter!
    expect(e.uniforms).toEqual([{ name: 'wxOcc', type: 'vec4' }])
    expect(e.samplers).toEqual(['wxOccMap'])
    expect(e.wgsl).not.toMatch(/^uniform/m)
    expect(e.glsl).not.toMatch(/uniform vec4 wxOcc/)
    expect(e.glsl).toContain('uniform sampler2D wxOccMap;')
    const bare = parseExtern('f', 'fn f() -> f32 { return uniforms.a.x + uniforms.b.y; }', 'uniform float a;\nfloat f() { return a + b.y; }')
    expect(bare.uniforms).toEqual([{ name: 'a', type: 'float' }, { name: 'b', type: 'vec4' }])
  })

  it('the call follows the function\'s position argument; the defines its source tests are collected', () => {
    const v3 = parseExtern('sroCloudShadow', 'fn sroCloudShadow(p: vec3f) -> f32 {\n#ifdef WX_OCC8\n  return 0.5;\n#endif\n  return 1.0;\n}\n', 'float sroCloudShadow(vec3 p) {\n#if defined(WX_OCC8)\n  return 0.5;\n#endif\n  return 1.0;\n}\n')
    expect(v3.arg).toBe('vec3')
    expect(v3.defines).toEqual(['WX_OCC8'])
    const x3 = { ...FAKE_EXTERNS, cloudShadow: v3 }
    expect(terrainPluginCode('wgsl', x3).CUSTOM_FRAGMENT_DEFINITIONS).toContain('sroCloud = sroCloudShadow(wp);')
    expect(terrainPluginCode('glsl', x3).CUSTOM_FRAGMENT_DEFINITIONS).toContain('sroCloud = sroCloudShadow(wp);')
    expect(FAKE_EXTERNS.cloudShadow!.arg).toBe('vec2')
    expect(terrainPluginCode('glsl', FAKE_EXTERNS).CUSTOM_FRAGMENT_DEFINITIONS).toContain('sroCloud = sroCloudShadow(wp.xz);')
    // The lanes' current sources (whatever they are now) are called with their own signature.
    const lanes = defaultTerrainExterns()
    for (const e of [lanes.shelter, lanes.cloudShadow]) {
      if (!e) continue
      const want = e.arg === 'vec2' ? 'wp.xz' : 'wp'
      expect(terrainPluginCode('wgsl', lanes).CUSTOM_FRAGMENT_DEFINITIONS).toContain(`${e.fn}(${want})`)
    }
  })

  it('an extern\'s own defines are mirrored from the terrain\'s define set (not the plugin\'s feature defines)', () => {
    const engine = new NullEngine()
    cleanups.push(() => engine.dispose())
    const scene = new Scene(engine)
    const on = new Set<string>()
    const src = 'fn sroShelter(p: vec3f) -> f32 {\n#ifdef WX_OCC8\n  return 0.0;\n#endif\n#ifdef SRO_SHELTER\n#endif\n  return 1.0;\n}\n'
    const x: TerrainExterns = { shelter: parseExtern('sroShelter', src, src.replace('fn sroShelter(p: vec3f) -> f32', 'float sroShelter(vec3 p)')), cloudShadow: null, nightSplat: null }
    const pbr = new TerrainPbr(scene, new Map(), x, { has: n => on.has(n) })
    expect(pbr.externDefines).toEqual(['WX_OCC8'])
    const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    const { plugin } = pbr.createMaterial('t', { originX: 0, originZ: 0, layerCount: 1, layerMap: tex, lightmap: null, textures: {} })
    let dirty = 0
    const mark = plugin.markAllDefinesAsDirty
    ;(plugin as { markAllDefinesAsDirty: () => void }).markAllDefinesAsDirty = () => {
      dirty++
      mark()
    }
    const defs: Record<string, boolean> = {}
    plugin.prepareDefines(defs as never)
    expect(defs.WX_OCC8).toBe(false)
    on.add('WX_OCC8')
    pbr.laneDefinesChanged()
    expect(dirty).toBe(1)
    plugin.prepareDefines(defs as never)
    expect(defs.WX_OCC8).toBe(true)
    pbr.laneDefinesChanged()
    expect(dirty).toBe(1)
  })

  it('an empty lane source is off; NL\'s night splat is wired with its own texture and nlNight', () => {
    const x = defaultTerrainExterns()
    // SKY-B and WX-R fill these later; while empty the feature cannot switch on.
    if (!x.cloudShadow) expect(resolveTerrainFeatures({ quality: RENDER_PRESETS.high, sky: SKY_PRESETS.high, externs: { shelter: false, cloudShadow: false, nightSplat: false } }).cloudShadow).toBe(false)
    if (x.nightSplat) {
      expect(x.nightSplat.samplers).toEqual(['nightSplat'])
      expect(x.nightSplat.uniforms).toEqual([{ name: 'nlNight', type: 'vec4' }])
      expect(terrainPluginCode('wgsl', x).CUSTOM_FRAGMENT_DEFINITIONS).toContain('sroNightSplat(nightSplat, nightSplatSampler, lp, uniforms.nlNight.x)')
    }
  })
})

describe('resolveTerrainFeatures', () => {
  const all = { shelter: true, cloudShadow: true, nightSplat: true }
  const f = (p: RenderPreset, level: WeatherLevel, arrays = { normal: false, ormh: false }, night = false) => resolveTerrainFeatures({
    quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[level], arrays, externs: all,
    defines: { has: n => night && n === TERRAIN_FEATURE_DEFINES.nightSplat },
  })

  it('Medium: detail + anti-tiling (TT-Q; + wet by the weather level); High: + height blend, triplanar; Ultra: + parallax', () => {
    const m = f('medium', 'off')
    expect(TERRAIN_FEATURES.filter(k => m[k])).toEqual(['detail', 'antiTiling'])
    const h = f('high', 'off')
    expect(TERRAIN_FEATURES.filter(k => h[k])).toEqual(['heightBlend', 'triplanar', 'detail', 'antiTiling', 'cloudShadow'])
    const u = f('ultra', 'off')
    expect(u.antiTiling).toBe(true)
    expect(u.parallax).toBe(false) // no ORMH array: no height to march
  })

  it('per-layer normals and ORMH only when their arrays exist (D39); parallax needs ORMH', () => {
    expect(f('high', 'off', { normal: true, ormh: true }).normals).toBe(true)
    expect(f('medium', 'off', { normal: true, ormh: true }).normals).toBe(false) // layerNormals is High+
    expect(f('ultra', 'off', { normal: false, ormh: true })).toMatchObject({ normals: false, ormh: true, parallax: true })
  })

  it('wet, puddles, ripples and shelter follow the weather level (WEATHER_PRESETS, §5.1)', () => {
    expect(f('high', 'off')).toMatchObject({ wet: false, puddles: false, ripples: false, shelter: false })
    expect(f('high', 'low')).toMatchObject({ wet: true, puddles: false, ripples: false })
    expect(f('medium', 'medium')).toMatchObject({ wet: true, puddles: true, ripples: true, shelter: WEATHER_PRESETS.medium.shelter })
    expect(f('ultra', 'ultra')).toMatchObject({ wet: true, puddles: true, ripples: true })
  })

  it('the night splat follows NL\'s define on the terrain; cloud shadows follow the sky preset', () => {
    expect(f('medium', 'off', undefined, true).nightSplat).toBe(true)
    expect(f('medium', 'off').nightSplat).toBe(false)
    expect(f('medium', 'off').cloudShadow).toBe(false) // SKY_PRESETS.medium: off
    expect(f('high', 'off').cloudShadow).toBe(true)
  })

  it('rain, day and night never change the define set (only these inputs do)', () => {
    const a = featureKey(f('high', 'high'))
    const b = featureKey(f('high', 'high'))
    expect(a).toBe(b)
    expect(featureKey(NO_TERRAIN_FEATURES)).toBe('0'.repeat(TERRAIN_FEATURES.length))
  })
})

// ---- NullEngine compiles ------------------------------------------------------------------------------------------

interface Rig {
  engine: NullEngine
  scene: Scene
  mesh: Mesh
  tex: RawTexture
}

/**
 * A NullEngine scene shaped like a PBR preset for the compile: WebGL2's textureLOD cap (LOD-based reflections: one
 * reflection sampler), a directional light 0 with a CSM (a stand-in generator: NullEngine has no depth textures) and
 * an environment cube with SH (a stand-in texture: NullEngine has no raw cube textures).
 */
function rig(): Rig {
  const engine = new NullEngine()
  engine.getCaps().textureLOD = true
  const scene = new Scene(engine)
  const sun = new DirectionalLight('celestial', new Vector3(-1, -1, 0), scene)
  const mesh = MeshBuilder.CreateGround('terrain', { width: 2, height: 2 }, scene)
  mesh.receiveShadows = true
  const csm = {
    id: 'csm',
    getShadowMap: () => ({ renderList: [mesh] }),
    isReady: () => true,
    prepareDefines: (d: Record<string, unknown>, i: number) => {
      d[`SHADOW${i}`] = true
      d[`SHADOWCSM${i}`] = true
      d[`SHADOWCSMNUM_CASCADES${i}`] = 3
      d[`SHADOWCSMUSESHADOWMAXZ${i}`] = true
      d[`SHADOWPCF${i}`] = true
    },
    bindShadowLight: () => {},
    getClassName: () => 'CascadedShadowGenerator',
    dispose: () => {},
  }
  ;(sun as unknown as { _shadowGenerators: Map<unknown, unknown> })._shadowGenerators = new Map([[null, csm]])
  const env = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  env.getInternalTexture()!.isCube = true
  env.sphericalPolynomial = new SphericalPolynomial()
  env.isReady = () => true
  scene.environmentTexture = env
  scene.createDefaultCamera()
  const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  cleanups.push(() => engine.dispose())
  return { engine, scene, mesh, tex }
}

async function compile(r: Rig, feats: TerrainFeatures, externs: TerrainExterns): Promise<{ glsl: string; defines: string[]; material: PBRMaterial }> {
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), externs)
  pbr.setFeatures(feats)
  pbr.tiles = pbr.normals = pbr.ormh = r.tex
  const { material } = pbr.createMaterial('t', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
  r.mesh.material = material
  let ready = false
  for (let i = 0; i < 600 && !ready; i++) {
    ready = material.isReadyForSubMesh(r.mesh, r.mesh.subMeshes[0]!)
    if (!ready) await new Promise(res => setTimeout(res, 5))
  }
  expect(ready, 'the material compiles').toBe(true)
  const effect = r.mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  let glsl = ''
  PreProcess(effect._fragmentSourceCode, { defines, isFragment: true, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => { glsl = c }, r.engine)
  cleanups.push(() => {
    material.dispose()
    pbr.dispose()
  })
  return { glsl, defines, material }
}

/** Distinct sampler uniforms of a preprocessed GLSL fragment (WebGL2 texture units). */
function samplersOf(glsl: string): string[] {
  return [...new Set([...glsl.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler\w+\s+(\w+)/g)].map(m => m[1]!))]
}

describe('NullEngine PBRMaterial + SroTerrainPlugin', () => {
  it('compiles, carries the plugin by name, and injects the splat, the baked sun and the AO', async () => {
    const r = rig()
    const feats = resolveTerrainFeatures({ quality: RENDER_PRESETS.high, sky: SKY_PRESETS.high, weather: WEATHER_PRESETS.high, arrays: { normal: true, ormh: true }, externs: { shelter: true, cloudShadow: true, nightSplat: false } })
    const { glsl, defines, material } = await compile(r, feats, FAKE_EXTERNS)
    expect(material.pluginManager?.getPlugin(SRO_TERRAIN_PLUGIN)).toBeTruthy()
    expect(defines).toEqual(expect.arrayContaining(['#define SROTERRAIN', '#define SRO_T_TRIPLANAR', '#define SRO_T_NORMALS', '#define SRO_SHELTER', '#define SHADOWCSM0', '#define REFLECTION']))
    expect(defines).not.toContain('#define SRO_T_PARALLAX')
    expect(glsl).toContain('sroTerrainEval();')
    expect(glsl).toMatch(/diffuse0\s*=\s*vec4\(diffuse0\.rgb \* sroV/)
    expect(glsl).toContain('aoOut.ambientOcclusionColor = aoOut.ambientOcclusionColor * sroAO;')
    expect(glsl).toContain('sroShelter(wp)')
  })

  it('a feature change marks the material dirty and recompiles with the new defines', async () => {
    const r = rig()
    const base = resolveTerrainFeatures({ quality: RENDER_PRESETS.medium })
    const pbr = new TerrainPbr(r.scene, new Map(), FAKE_EXTERNS)
    pbr.setFeatures(base)
    pbr.tiles = r.tex
    const { material, plugin } = pbr.createMaterial('t', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
    r.mesh.material = material
    for (let i = 0; i < 600 && !material.isReadyForSubMesh(r.mesh, r.mesh.subMeshes[0]!); i++) await new Promise(res => setTimeout(res, 5))
    expect(pbr.plugins.has(plugin)).toBe(true)
    expect(pbr.setFeatures(base)).toBe(false)
    expect(pbr.setFeatures({ ...base, triplanar: true })).toBe(true)
    let ready = false
    for (let i = 0; i < 600 && !ready; i++) {
      r.scene.incrementRenderId() // readiness is cached per frame
      ready = material.isReadyForSubMesh(r.mesh, r.mesh.subMeshes[0]!) && (r.mesh.subMeshes[0]!.effect?.defines ?? '').includes('SRO_T_TRIPLANAR')
      if (!ready) await new Promise(res => setTimeout(res, 5))
    }
    expect(ready).toBe(true)
    material.dispose()
    expect(pbr.plugins.has(plugin)).toBe(false)
    pbr.dispose()
  })

  // D32: WebGL2 has 16 texture units per stage. Babylon's own units (shadow map, reflection cube, BRDF LUT) are
  // compiled here with stand-ins; the clustered light container (NullEngine cannot build one) adds its two textures
  // (lightDataTexture, tileMaskTexture: lightUboDeclaration CLUSTLIGHT) on every preset that has a cluster.
  const presets: RenderPreset[] = ['medium', 'high', 'ultra']
  const levels: WeatherLevel[] = ['off', 'low', 'medium', 'ultra']
  const cases = presets.flatMap(p => levels.flatMap(l => [false, true].flatMap(arrays => [false, true].map(night => [p, l, arrays, night] as const))))
  it('WebGL2: ≤ 16 texture units for every final define set (D32)', async () => {
    // The lanes' own helper sources where they exist (their real samplers), the lane-shaped fakes otherwise.
    const lanes = defaultTerrainExterns()
    const d32: TerrainExterns = { shelter: lanes.shelter ?? FAKE_EXTERNS.shelter, cloudShadow: lanes.cloudShadow ?? FAKE_EXTERNS.cloudShadow, nightSplat: lanes.nightSplat ?? FAKE_EXTERNS.nightSplat }
    const r = rig()
    const seen = new Map<string, number>()
    let worst = { n: 0, what: '' }
    for (const [p, l, arrays, night] of cases) {
      const feats = resolveTerrainFeatures({
        quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[l], arrays: { normal: arrays, ormh: arrays },
        externs: { shelter: true, cloudShadow: true, nightSplat: true }, defines: { has: () => night },
      })
      const key = featureKey(feats)
      let n = seen.get(key)
      if (n === undefined) {
        const { glsl } = await compile(r, feats, d32)
        n = samplersOf(glsl).length
        seen.set(key, n)
      }
      const total = n + (RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0)
      if (total > worst.n) worst = { n: total, what: `${p}/${l}/arrays ${arrays}/night ${night}` }
      expect(total, `${p} weather ${l} arrays ${arrays} night ${night}`).toBeLessThanOrEqual(16)
    }
    // Sanity: the worst case really has everything (Ultra, full weather, arrays, the three externs).
    expect(worst.n).toBeGreaterThanOrEqual(15)
  }, 120_000)
})

describe('procedural detail layers', () => {
  it('three tileable RGBA layers with a neutral mean', () => {
    const layers = makeDetailLayers(32)
    expect(layers).toHaveLength(3)
    for (const l of layers) {
      expect(l.length).toBe(32 * 32 * 4)
      let b = 0, r = 0
      for (let i = 0; i < l.length; i += 4) {
        b += l[i + 2]!
        r += l[i]!
        expect(l[i + 3]).toBe(255)
      }
      expect(Math.abs(b / (32 * 32) - 127.5)).toBeLessThan(12)
      expect(Math.abs(r / (32 * 32) - 127.5)).toBeLessThan(12)
    }
    expect(makeDetailLayers(32)[1]).toEqual(layers[1]) // deterministic
  })
})

/**
 * TT-Q (TERRAIN_TEX §4.3, F5, F6): the class is read `& 63` past the no-anti-tile bit (64) in both languages, the bit
 * skips the anti-tiling tap (the paving), and under SRO_T_TIER the second tap reads `sroTilesHi` for the layers below
 * the tier cap, like the first.
 */
describe('TT-Q: the no-anti-tile bit and the tier second tap', () => {
  it('both languages mask the class and test the bit inside the anti-tiling block', () => {
    const w = terrainPluginCode('wgsl', FAKE_EXTERNS).CUSTOM_FRAGMENT_DEFINITIONS!
    const g = terrainPluginCode('glsl', FAKE_EXTERNS).CUSTOM_FRAGMENT_DEFINITIONS!
    expect(w).toContain('let sc = ab & 63;')
    expect(g).toContain('int sc = ab & 63;')
    for (const [src, tap] of [[w, 'textureSampleGrad(sroTilesHi, sroTilesSampler, ruv, idx, rgx, rgy)'], [g, 'textureGrad(sroTilesHi, vec3(ruv, idx), rgx, rgy)']] as const) {
      expect(src).not.toMatch(/255\.0 \+ 0\.5\) - 128/)
      const block = src.slice(src.indexOf(`#ifdef ${TERRAIN_FEATURE_DEFINES.antiTiling}`))
      expect(block.indexOf('if ((ab & 64) == 0) {')).toBeGreaterThan(0)
      expect(block.indexOf(`#ifdef ${TERRAIN_FEATURE_DEFINES.tier}`)).toBeGreaterThan(block.indexOf('if ((ab & 64) == 0) {'))
      expect(block.indexOf(tap)).toBeGreaterThan(block.indexOf(`#ifdef ${TERRAIN_FEATURE_DEFINES.tier}`))
    }
  })

  it('GLSL compiles with anti-tiling and the tier: the second tap reads sroTilesHi; without the tier it does not', async () => {
    const r = rig()
    const base = { ...NO_TERRAIN_FEATURES, detail: true, antiTiling: true }
    const tiered = await compile(r, { ...base, tier: true }, FAKE_EXTERNS)
    expect(tiered.defines).toEqual(expect.arrayContaining([`#define ${TERRAIN_FEATURE_DEFINES.antiTiling}`, `#define ${TERRAIN_FEATURE_DEFINES.tier}`]))
    expect(tiered.glsl).toContain('textureGrad(sroTilesHi, vec3(ruv, idx), rgx, rgy)')
    const flat = await compile(r, base, FAKE_EXTERNS)
    expect(flat.glsl).toContain('textureGrad(sroTiles, vec3(ruv, idx), rgx, rgy)')
    expect(flat.glsl).not.toContain('sroTilesHi, vec3(ruv')
  })
})
