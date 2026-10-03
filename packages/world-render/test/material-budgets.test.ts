/**
 * The shared material budgets (docs/WAVE_PLAN6.md D13, §5.4 G4; WAVE_PLAN4 D16; BATCHING F7/F8, GRASS_LIFE X6, COAST
 * F16, WAVE_PLAN3 D32): one guard for the sum every lane adds, run after every merge that adds a material, a define or
 * a texture array.
 *
 * - **WebGL2 texture units ≤ 16** for every final define set of every registered material (NullEngine, the GLSL a
 *   WebGL2 device compiles: the preprocessed fragment's distinct samplers; the cluster's two textures added where the
 *   preset has a cluster).
 * - **Inter-stage variables ≤ 16**: at most 15 user varyings plus `front_facing` when the fragment reads it, counted
 *   with render/gpu-guards.ts `wgslInterStageCount` (the WGSL count Chrome applies; Babylon declares the same varyings
 *   in both languages, so the preprocessed GLSL's varyings stand in for the WGSL struct on NullEngine).
 * - **Every texture array ≤ 256 layers** (WebGPU's default `maxTextureArrayLayers`, GLES 3.0's minimum).
 *
 * Each lane registers its own material builders and define sets in MATERIALS and its arrays in ARRAYS (BT-P: the batch
 * group material with every define on; CST-O: the ocean per preset; CST-S: the coast wet band on the terrain; GL-S /
 * GL-F: the grass field; GL-L: the life kinds; BT-A: the atlas and lightmap arrays). Lanes whose source is still empty
 * are represented here by lane-shaped stand-ins, so the guard already holds the wave's worst case.
 */
import {
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  SphericalPolynomial,
  StandardMaterial,
  Vector3,
  Vector4,
  type Material,
  type Mesh,
} from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  COAST_WET_DEFINE,
  GRASS_TINT_DEFINE,
  RENDER_PRESETS,
  SKY_PRESETS,
  STREAM_DEFAULTS,
  WEATHER_PRESETS,
  WORLD_SHADER_CHUNKS,
  WaterPbrState,
  createPbrWater,
  scatterShaders,
  terrainShaders,
  waterShaders,
  wgslInterStageCount,
  type InterStageCount,
  type RenderPreset,
  type RenderQuality,
  type ShaderSources,
  type WeatherLevel,
} from '../src/index.ts'
import {
  TerrainPbr,
  defaultTerrainExterns,
  featureKey,
  parseExtern,
  resolveTerrainFeatures,
  terrainUnits,
  type TerrainExterns,
  type TerrainFeatures,
} from '../src/pbr/terrain-plugin.ts'
import { grassShaders } from '../src/grass/shaders.ts'
import { grassRingShaders } from '../src/grass/ring-shaders.ts'
import { birdShaders, critterShaders, fireflyShaders } from '../src/life/shaders.ts'
import { TILE_TIER_LAYERS } from '../src/tile-atlas.ts'
import { MAX_ARRAY_LAYERS, encodedSize } from '../src/batch/atlas.ts'
import { lightmapLayers } from '../src/batch/lightmaps.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { FOLIAGE_MIN_BREEZE, FOLIAGE_PIVOT_KIND, FOLIAGE_TREEW_KIND, FoliageShared, SroFoliagePlugin, TREE_PIVOT_FLOATS } from '../src/pbr/foliage-plugin.ts'
import { RIPPLE_POINTS_MAX, SroWaterTownPlugin, WaterTownState } from '../src/pbr/water-town-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import { CDLOD_MAX_NODES } from '../src/ocean/cdlod.ts'
import { CLASSIC_OCEAN_SAMPLERS, classicOceanShaders } from '../src/ocean/ocean-classic.ts'
import { CDLOD_ATTRIBUTE, OceanPbrState, createOceanMaterial } from '../src/ocean/ocean-plugin.ts'
import { GPU_TILES_M, WORKER_TILES_M } from '../src/ocean/spectrum.ts'
import { SHORE_SAMPLERS } from '../src/shore/chunks.ts'
import { cutoutCasterShaders } from '../src/render/shadows.ts'
import { createFxMaterials } from '../src/town/fx.ts'
import { SRO_TOWN_FADE_PLUGIN, SroTownFadePlugin, stubCrowdAssets } from '../src/town/crowd.ts'
import { interStageNames } from './inter-stage.ts'

/** WebGL2's fragment texture units, the inter-stage limit (Chrome), the layer limit. */
const MAX_UNITS = 16
const MAX_USER_VARYINGS = 15
const MAX_INTER_STAGE = 16
const MAX_LAYERS = 256

// ---- the NullEngine rig (a PBR preset's scene: CSM on light 0, an environment cube with SH, textureLOD) ----------

interface Rig {
  engine: NullEngine
  scene: Scene
  mesh: Mesh
  tex: RawTexture
}

const rigs: Rig[] = []
afterAll(() => {
  for (const r of rigs.splice(0)) r.engine.dispose()
})

function rig(): Rig {
  const engine = new NullEngine()
  engine.getCaps().textureLOD = true
  const scene = new Scene(engine)
  const sun = new DirectionalLight('celestial', new Vector3(-1, -1, 0), scene)
  const mesh = MeshBuilder.CreateGround('probe', { width: 2, height: 2 }, scene)
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
  const r = { engine, scene, mesh, tex }
  rigs.push(r)
  return r
}

/** What one compiled material costs. */
interface Cost {
  units: number
  varyings: InterStageCount
}

/**
 * Compiles `material` on the rig's mesh and counts its preprocessed GLSL (WebGL2). `cluster`: the preset's night cluster
 * (it adds `vViewDepth` to every lit PBR material, BF-1).
 */
async function compileCost(r: Rig, material: Material, cluster = false): Promise<Cost> {
  r.mesh.material = material
  let ready = false
  for (let i = 0; i < 600 && !ready; i++) {
    ready = material.isReadyForSubMesh(r.mesh, r.mesh.subMeshes[0]!)
    if (!ready) await new Promise(res => setTimeout(res, 5))
  }
  expect(ready, `${material.name} compiles`).toBe(true)
  const effect = r.mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string; _vertexSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  const pre = (code: string, isFragment: boolean): string => {
    let out = ''
    PreProcess(code, { defines, isFragment, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => { out = c }, r.engine)
    return out
  }
  const frag = pre(effect._fragmentSourceCode, true)
  const vert = pre(effect._vertexSourceCode, false)
  return { units: samplersOf(frag).length, varyings: varyingsOf(vert, /\bgl_FrontFacing\b/.test(frag), cluster) }
}

/** Distinct sampler uniforms of preprocessed GLSL. */
function samplersOf(glsl: string): string[] {
  return [...new Set([...glsl.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler\w+\s+(\w+)/g)].map(m => m[1]!))]
}

/**
 * The inter-stage count of a preprocessed GLSL vertex shader: its varyings as the WGSL FragmentInputs struct Babylon
 * writes (one @location each: the CSM arrays as their 4 + 4 unrolled members, a matN as N, the cluster's vViewDepth;
 * inter-stage.ts, BF-1), plus front_facing when the fragment reads it, through `wgslInterStageCount`.
 */
function varyingsOf(vertexGlsl: string, frontFacing: boolean, cluster = false): InterStageCount {
  return wgslStruct(interStageNames(vertexGlsl, cluster), frontFacing)
}

function wgslStruct(names: readonly string[], frontFacing: boolean): InterStageCount {
  const members = names.map((n, i) => `  @location(${i}) ${n}: vec4f,`).join('\n')
  const body = `struct FragmentInputs {\n  @builtin(position) position: vec4<f32>,\n${members}\n};\nfn main(input: FragmentInputs) {${frontFacing ? ' let f = fragmentInputs.frontFacing;' : ''} }`
  return wgslInterStageCount(body)
}

// ---- the lanes' stand-ins (lane-shaped: their stated samplers and uniforms) --------------------------------------

/** WX-R's shelter and SKY-B's cloud shadow where their real source is empty (one texture and one vec4 each). */
const FAKE_SHELTER = parseExtern('sroShelter',
  'uniform wxOcc: vec4f;\nvar wxOccMap: texture_2d<f32>;\nvar wxOccMapSampler: sampler;\nfn sroShelter(p: vec3f) -> f32 {\n  return textureSampleLevel(wxOccMap, wxOccMapSampler, (p.xz - uniforms.wxOcc.xy) * uniforms.wxOcc.w + vec2f(0.5), 0.0).r;\n}\n',
  'uniform vec4 wxOcc;\nuniform sampler2D wxOccMap;\nfloat sroShelter(vec3 p) {\n  return textureLod(wxOccMap, (p.xz - wxOcc.xy) * wxOcc.w + vec2(0.5), 0.0).r;\n}\n')
const FAKE_CLOUD = parseExtern('sroCloudShadow',
  'uniform skyCloud: vec4f;\nvar skyCloudNoise: texture_2d<f32>;\nvar skyCloudNoiseSampler: sampler;\nfn sroCloudShadow(xz: vec2f) -> f32 {\n  return 1.0 - textureSampleLevel(skyCloudNoise, skyCloudNoiseSampler, xz * uniforms.skyCloud.x, 0.0).r * uniforms.skyCloud.y;\n}\n',
  'uniform vec4 skyCloud;\nuniform sampler2D skyCloudNoise;\nfloat sroCloudShadow(vec2 xz) {\n  return 1.0 - textureLod(skyCloudNoise, xz * skyCloud.x, 0.0).r * skyCloud.y;\n}\n')
/**
 * CST-S's wet band (COAST §8.6, F16): the coast field is one more texture, read only where the shelter map is off (the
 * fallback COAST names for a full set: WebGL2 High/Ultra with full weather are at 15–16 units already); CST-S replaces
 * this stand-in with its source and keeps this guard green.
 */
const FAKE_COAST = parseExtern('sroCoastWet',
  '#ifndef SRO_SHELTER\nuniform coastField: vec4f;\nvar coastWet: texture_2d<f32>;\nvar coastWetSampler: sampler;\n#endif\nfn sroCoastWet(p: vec3f) -> f32 {\n#ifndef SRO_SHELTER\n  return textureSampleLevel(coastWet, coastWetSampler, p.xz * uniforms.coastField.x + uniforms.coastField.yz, 0.0).r;\n#else\n  return 0.0;\n#endif\n}\n',
  '#ifndef SRO_SHELTER\nuniform vec4 coastField;\nuniform sampler2D coastWet;\n#endif\nfloat sroCoastWet(vec3 p) {\n#ifndef SRO_SHELTER\n  return textureLod(coastWet, p.xz * coastField.x + coastField.yz, 0.0).r;\n#else\n  return 0.0;\n#endif\n}\n')
/** GL-T's tint (GRASS_LIFE X6): a per-tile uniform table, no sampler. */
const FAKE_TINT = parseExtern('sroGrassTint',
  'uniform grassTint: vec4f;\nfn sroGrassTint(alb: vec3f, lp: vec2f, wp: vec3f) -> vec3f {\n  return mix(alb, uniforms.grassTint.rgb, uniforms.grassTint.a * step(0.0, lp.x + wp.y));\n}\n',
  'uniform vec4 grassTint;\nvec3 sroGrassTint(vec3 alb, vec2 lp, vec3 wp) {\n  return mix(alb, grassTint.rgb, grassTint.a * step(0.0, lp.x + wp.y));\n}\n')

/** Every terrain extern: the lane's real source where it has one, its stand-in otherwise. */
function terrainExterns(): TerrainExterns {
  const x = defaultTerrainExterns()
  return {
    shelter: x.shelter ?? FAKE_SHELTER,
    cloudShadow: x.cloudShadow ?? FAKE_CLOUD,
    nightSplat: x.nightSplat,
    coastWet: x.coastWet ?? FAKE_COAST,
    grassTint: x.grassTint ?? FAKE_TINT,
  }
}

// ---- the registry ---------------------------------------------------------------------------------------------------

interface MaterialCase {
  name: string
  /** Every final define set of this material: builds it on the rig and returns its cost (plus units the engine adds). */
  sets(): AsyncGenerator<{ label: string; cost: Cost; extraUnits: number }>
}

const PRESETS: readonly RenderPreset[] = ['medium', 'high', 'ultra']
const LEVELS: readonly WeatherLevel[] = ['off', 'low', 'medium', 'ultra']

/**
 * The PBR terrain (RND-T's plugin with the five externs): presets × weather × each map array (normal, ORMH, tier plane)
 * × night × coast × tint, with the preset's height fog attached as the scene attaches it (U-1: its horizon-ring sampler
 * on High/Ultra) and the preset's night cluster.
 */
const TERRAIN_PBR: MaterialCase = {
  name: 'terrain (PBR, wave-10 externs)',
  async *sets() {
    const r = rig()
    const externs = terrainExterns()
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    const seen = new Map<string, Cost>()
    for (const p of PRESETS) for (const l of LEVELS) for (let a = 0; a < 8; a++) for (const night of [false, true]) {
      const q = RENDER_PRESETS[p]
      const arrays = { normal: !!(a & 1), ormh: !!(a & 2), tier: !!(a & 4) }
      for (const coast of [false, true]) for (const tint of [false, true]) {
        const defs = new Set<string>([...(night ? ['SRO_NIGHT_SPLAT'] : []), ...(coast ? [COAST_WET_DEFINE] : []), ...(tint ? [GRASS_TINT_DEFINE] : [])])
        const feats = resolveTerrainFeatures({
          quality: q, sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[l], arrays,
          externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true }, defines: { has: n => defs.has(n) },
        })
        const cluster = q.nightLights.cluster > 0
        const key = `${q.fog}|${q.horizonRingFog}|${cluster}|${featureKey(feats)}`
        let cost = seen.get(key)
        if (!cost) {
          cost = await terrainCost(r, feats, externs, { fog, quality: q })
          seen.set(key, cost)
        }
        yield { label: `${p}/${l}/normal ${arrays.normal}/ormh ${arrays.ormh}/tier ${arrays.tier}/night ${night}/coast ${coast}/tint ${tint}`, cost, extraUnits: cluster ? 2 : 0 }
      }
    }
  },
}

/** Builds and costs one terrain set; `withFog`: the scene's height fog as the preset sets it (and its night cluster). */
async function terrainCost(r: Rig, feats: TerrainFeatures, externs: TerrainExterns, withFog?: { fog: HeightFog; quality: Readonly<RenderQuality> }): Promise<Cost> {
  if (withFog) withFog.fog.setActive(withFog.quality.fog === 'height', withFog.quality.horizonRingFog)
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), externs)
  pbr.setFeatures(feats)
  pbr.tiles = pbr.normals = pbr.ormh = pbr.tilesHi = r.tex
  const { material } = pbr.createMaterial('terrain', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
  if (withFog && withFog.quality.fog === 'height') attachFogPlugin(material, withFog.fog)
  try {
    return await compileCost(r, material, !!withFog && withFog.quality.nightLights.cluster > 0)
  } finally {
    material.dispose()
    pbr.dispose()
  }
}

/**
 * RND-W's PBR water: every switch (depth shore, ripples) on every preset; W11-S: and with the town plugin (ripple
 * points and the 'town' profile both on; no sampler, no varying of its own).
 */
const WATER_PBR: MaterialCase = {
  name: 'water (PBR; W11-S: + the town plugin)',
  async *sets() {
    const r = rig()
    for (const p of PRESETS) for (const shore of [false, true]) for (const ripple of [false, true]) for (const town of [false, true]) {
      const state = new WaterPbrState()
      state.frames = state.normal = r.tex
      state.setSwitches(shore, ripple ? r.tex : null)
      const { material } = createPbrWater(r.scene, state)
      if (town) {
        const ts = new WaterTownState()
        ts.setPoints(Array.from({ length: RIPPLE_POINTS_MAX }, (_, i) => ({ x: i, z: 0, radiusM: 2, strength: 1 })))
        ts.setProfile({ color: [0.2, 0.25, 0.12], turbidity: 0.7, reflection: 0.5 })
        new SroWaterTownPlugin(material, ts)
      }
      try {
        const cost = await compileCost(r, material, RENDER_PRESETS[p].nightLights.cluster > 0)
        if (town) {
          const d = r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
          expect([d.SRO_WATER, d.SRO_WATER_POINTS, d.SRO_WATER_PROFILE], 'the town plugin on').toEqual([true, true, true])
        }
        yield { label: `${p}/shore ${shore}/ripple ${ripple}/town ${town}`, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
      } finally {
        material.dispose()
      }
    }
  },
}

/**
 * The Classic ShaderMaterials (terrain, water, retail grass) with every lane's chunks: every declared sampler (the upper
 * bound: each is bound, a black fallback until its lane binds one) and every declared varying.
 */
function classicCase(name: string, src: ShaderSources): MaterialCase {
  return {
    name,
    async *sets() {
      const names = [...src.vertexWGSL.matchAll(/^\s*varying\s+(\w+)\s*:/gm)].map(m => m[1]!)
      const front = /front_facing|frontFacing/.test(src.fragmentWGSL)
      yield { label: 'all chunks', cost: { units: src.samplers.length, varyings: wgslStruct([...new Set(names)], front) }, extraUnits: 0 }
    },
  }
}

/**
 * BT-P: a region batch's group material (SRO_TABLE, docs/BATCHING.md §3.4, F8): the material table and the three atlas
 * arrays, no 2D map, with every define on at once: wet + puddles + the shelter map + the cloud shadow (where their
 * chunks ship), the lamp glow (SRO_LAMP + SRO_SELFLIT), the alpha test, the merged trees' foliage (wind, flutter,
 * translucency, SRO_FOL_PIVOT, SRO_FOL_BREEZE), the height fog with its ring, the cloth sheen (High+), and the night
 * cluster's two textures on the presets that have one.
 */
const BATCH_GROUP: MaterialCase = {
  name: 'region batch group (BT-P: SRO_TABLE, every define on)',
  async *sets() {
    const r = rig()
    r.tex.getInternalTexture()!.isReady = true
    r.tex.isReady = () => true
    const n = r.mesh.getTotalVertices()
    r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
    r.mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * 3), false, 3)
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    const wind = { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) }
    for (const p of PRESETS) for (const sheen of [false, true]) {
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const mat = new PBRMaterial(`batch:${p}${sheen ? '+sheen' : ''}`, r.scene)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.sheen.isEnabled = sheen
      new SroSurfacePlugin(mat, shared, { cls: sheen ? 'cloth' : 'foliage', lamp: true, selfLit: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: wind })
      new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      attachFogPlugin(mat, fog)
      try {
        const cost = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
        const d = r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
        expect([d.SRO_TABLE, d.SRO_WET, d.SRO_PUDDLES, d.SRO_SELFLIT, d.SRO_FOL_PIVOT, d.SRO_FOL_BREEZE, d.SRO_FOG_RING, d.ALPHATEST], 'every define on').toEqual([true, true, true, true, true, true, true, true])
        yield { label: `${p}/sheen ${sheen}`, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
      } finally {
        mat.dispose()
      }
    }
  },
}

/**
 * W11-S (TOWN_LIFE §5.1, WAVE_PLAN7 §4.3 step 3): a region batch's `+sheen` group with cloth (the cloth group's define
 * set): the table material with every surface define on, the foliage plugin's cloth slot (SRO_CLOTH_WIND on a mesh with
 * the 4-float pivot, SRO_FOL_BREEZE), opaque and cut-out, the height fog with its ring, the cloth sheen (High+), and the
 * night cluster. TL-M's chunk adds no varying (it moves `worldPos`), so this holds the cloth groups' worst case.
 */
const CLOTH_GROUP: MaterialCase = {
  name: 'region batch +sheen cloth group (W11-S: SRO_CLOTH_WIND, every define on)',
  async *sets() {
    const r = rig()
    r.tex.getInternalTexture()!.isReady = true
    r.tex.isReady = () => true
    const n = r.mesh.getTotalVertices()
    r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
    r.mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * 4).fill(1), false, 4)
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    const wind = { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) }
    for (const p of PRESETS) for (const cutout of [false, true]) {
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const mat = new PBRMaterial(`batch:${cutout ? 'cutout' : 'opaque'}+sheen`, r.scene)
      if (cutout) mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.sheen.isEnabled = p !== 'medium'
      new SroSurfacePlugin(mat, shared, { cls: 'cloth', baked: true, selfLit: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: wind })
      new SroFoliagePlugin(mat, fol, { leaf: false, kind: 'static', cloth: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      attachFogPlugin(mat, fog)
      try {
        const cost = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
        const d = r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
        expect([d.SRO_TABLE, d.SRO_WET, d.SRO_PUDDLES, d.SRO_CLOTH_WIND, d.SRO_FOL_BREEZE, d.SRO_FOG_RING, !!d.ALPHATEST], 'every define on').toEqual([true, true, true, true, true, true, cutout])
        yield { label: `${p}/cutout ${cutout}`, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
      } finally {
        mat.dispose()
      }
    }
  },
}

/**
 * W12-SA (WAVE_PLAN8 D8, D14; TREES §W3.3–§W3.4): a region batch's wave-12 tree group (the tree groups' define set):
 * the table material with every surface define on, the foliage plugin as a tree plugin (`tree: true`) on a mesh with the
 * 4-float tree pivot and the `sroTreeW` wind data (SRO_FOL_PIVOT + SRO_FOL_PIVOT4, SRO_FOL_VDATA, the wind, flutter,
 * translucency, SRO_FOL_BREEZE), leaf and wood, cut-out and opaque, the height fog with its ring, and the night cluster.
 * T12-W: SRO_FOL_BAND on too (the band texture set; its sampler is a vertex-stage texture, no fragment unit); T12-W and
 * T12-N assert their additions in their own describe blocks against this registered set.
 */
const TREE_GROUP: MaterialCase = {
  name: 'region batch wave-12 tree group (W12-SA: tree plugin, SRO_FOL_PIVOT4 + SRO_FOL_VDATA, every define on)',
  async *sets() {
    const r = rig()
    r.tex.getInternalTexture()!.isReady = true
    r.tex.isReady = () => true
    const n = r.mesh.getTotalVertices()
    r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
    r.mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * TREE_PIVOT_FLOATS).fill(1), false, TREE_PIVOT_FLOATS)
    r.mesh.setVerticesData(FOLIAGE_TREEW_KIND, new Float32Array(n * 4).fill(0.5), false, 4)
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    const wind = { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) }
    for (const p of PRESETS) for (const leaf of [false, true]) for (const cutout of [false, true]) {
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const mat = new PBRMaterial(`batch:tree:${leaf ? 'leaf' : 'wood'}${cutout ? '+cutout' : ''}`, r.scene)
      if (cutout) mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      new SroSurfacePlugin(mat, shared, { cls: leaf ? 'foliage' : 'wood', baked: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: wind })
      fol.setBand(r.tex)
      new SroFoliagePlugin(mat, fol, { leaf, kind: 'static', tree: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      attachFogPlugin(mat, fog)
      try {
        const cost = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
        const d = r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
        expect([d.SRO_TABLE, d.SRO_WET, d.SRO_FOL_PIVOT, d.SRO_FOL_PIVOT4, d.SRO_FOL_VDATA, d.SRO_FOL_BAND, d.SRO_FOL_BREEZE, d.SRO_FOL_FLUTTER, d.SRO_FOG_RING, !!d.ALPHATEST], 'every define on')
          .toEqual([true, true, true, true, true, true, true, leaf, true, cutout])
        yield { label: `${p}/${leaf ? 'leaf' : 'wood'}/cutout ${cutout}`, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
      } finally {
        mat.dispose()
      }
    }
  },
}

/**
 * TL-M (TOWN_LIFE §5.2–§5.3, WAVE_PLAN7 §6.1): the town's two motion layers, thin-instanced quads with the instance
 * colour: the puffs (alpha-blended, lit) and the leaves (alpha-tested, two-sided), each with one procedural texture,
 * on every PBR preset's night cluster.
 */
const TOWN_FX: MaterialCase = {
  name: 'town fx: puffs and leaves (TL-M, thin instances + instance colour)',
  async *sets() {
    const r = rig()
    const one = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    r.mesh.thinInstanceSetBuffer('matrix', one, 16, false)
    r.mesh.thinInstanceSetBuffer('color', new Float32Array([1, 1, 1, 1]), 4, false)
    r.mesh.hasVertexAlpha = true
    const { puff, leaf, textures } = createFxMaterials(r.scene)
    for (const t of textures) {
      t.getInternalTexture()!.isReady = true
      t.isReady = () => true
    }
    for (const p of PRESETS) for (const mat of [puff, leaf]) {
      const cost = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
      const d = r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
      expect([!!d.THIN_INSTANCES, !!d.INSTANCESCOLOR], `${mat.name}: thin instances with their colour`).toEqual([true, true])
      yield { label: `${p}/${mat.name}`, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
    }
    puff.dispose()
    leaf.dispose()
  },
}

/**
 * TL-C (TOWN_LIFE §3.2, §8.3): a crowd variant's material, a character-like PBR set: the surface plugin as the character
 * decoration dresses it (every weather define on), the height fog with its ring, the VAT sampler, the albedo atlas and
 * a normal map (the worst case of TL-V's variants), thin instances with the instance colour and the dither fade, on
 * every PBR preset with its night cluster; compiled with INSTANCES (a real engine draws thin instances instanced).
 */
const TOWN_CROWD: MaterialCase = {
  name: 'town crowd variant (TL-C: VAT + thin instances + instance colour + fade, surface, fog)',
  async *sets() {
    const r = rig()
    r.tex.getInternalTexture()!.isReady = true
    r.tex.isReady = () => true
    const assets = stubCrowdAssets(r.scene)
    const mesh = assets.variants.find(v => v.kind === 'folk')!.mesh
    mesh.thinInstanceSetBuffer('matrix', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16, false)
    mesh.thinInstanceSetBuffer('bakedVertexAnimationSettingsInstanced', new Float32Array([0, 10, 0, 30]), 4, false)
    mesh.thinInstanceSetBuffer('color', new Float32Array([1, 1, 1, 0.5]), 4, false)
    mesh.isVisible = true
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    try {
      for (const p of PRESETS) {
        const shared = new SurfaceShared()
        shared.wet = true
        shared.puddles = true
        shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
        shared.cloud = new Vector4(1, 1, 1, 1)
        shared.cloudProj = new Vector4(1, 1, 1, 1)
        shared.cloudNoise = r.tex
        const mat = new PBRMaterial(`town:crowd/${p}`, r.scene)
        mat.albedoTexture = r.tex
        mat.bumpTexture = r.tex
        mat.sheen.isEnabled = p !== 'medium'
        new SroSurfacePlugin(mat, shared, { cls: 'cloth' })
        new SroTownFadePlugin(mat)
        attachFogPlugin(mat, fog)
        const ready = mat.isReadyForSubMesh.bind(mat)
        mat.isReadyForSubMesh = (m, sm) => ready(m, sm, true)
        mesh.material = mat
        try {
          const cost = await compileCost({ ...r, mesh }, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
          const d = mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
          expect(mat.pluginManager?.getPlugin(SRO_TOWN_FADE_PLUGIN)).toBeTruthy()
          expect([d.BAKED_VERTEX_ANIMATION_TEXTURE, d.INSTANCES, d.THIN_INSTANCES, d.INSTANCESCOLOR, d.SRO_TOWN_FADE, d.SRO_WET], 'every define on').toEqual([true, true, true, true, true, true])
          yield { label: p, cost, extraUnits: RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0 }
        } finally {
          mat.dispose()
        }
      }
    } finally {
      assets.dispose()
    }
  },
}

/**
 * CST-O: the ocean's PBR material (ocean-plugin.ts) on every PBR preset as its preset row sets it (Medium: the worker
 * tile, two ticks interpolated; High/Ultra: the GPU tile, four cascades, the CSM received), with and without the rain
 * ripples, the height fog and its ring attached; on a thin-instanced grid (the INSTANCES define and the node
 * attribute, F1). Extra units: the night cluster's two textures, and one for shore v1's lace (CST-S's stand-in while
 * `SHORE_SAMPLERS` is empty; CST-S's real samplers are counted by the plugin once it declares them).
 */
const OCEAN_PBR: MaterialCase = {
  name: 'ocean (PBR, CST-O: per preset, with the shore lace)',
  async *sets() {
    const base = rig()
    const probe = MeshBuilder.CreateGround('oceanProbe', { width: 1, height: 1, subdivisions: 2 }, base.scene)
    const m = new Float32Array(CDLOD_MAX_NODES * 16)
    for (let i = 0; i < CDLOD_MAX_NODES; i++) m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16)
    probe.thinInstanceSetBuffer('matrix', m, 16, true)
    probe.thinInstanceSetBuffer(CDLOD_ATTRIBUTE, new Float32Array(CDLOD_MAX_NODES * 4), 4, false)
    probe.thinInstanceCount = 4
    const r: Rig = { ...base, mesh: probe }
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    for (const p of PRESETS) for (const ripple of [false, true]) {
      const q = RENDER_PRESETS[p].ocean
      const st = new OceanPbrState()
      st.waves = st.field = st.normal = st.frames = r.tex
      // CST-S: the shore live (SRO_OCEAN_SHORE), so its lace sampler is counted by the compile.
      const sv = new Vector4(0, 9, 0.4, 0.5)
      st.shore = { ready: true, update() {}, bind(b) { b.vec4('sroShoreA', sv); b.vec4('sroShoreB', sv); b.texture('sroShoreLace', r.tex) }, dispose() {} }
      st.setSwitches({ lerp: q.waves !== 'gpu-fft', cascades4: q.waves === 'gpu-fft', ripple: ripple ? r.tex : null })
      probe.receiveShadows = q.shadows
      const { material } = createOceanMaterial(r.scene, st)
      attachFogPlugin(material, fog)
      try {
        const cost = await compileCost(r, material, RENDER_PRESETS[p].nightLights.cluster > 0)
        const d = probe.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>
        // (INSTANCES follows the draw's instancing flag, which compileCost does not pass; it adds attributes, not
        // varyings or samplers. test/ocean-plugin.test.ts checks it.)
        expect([d.SRO_OCEAN, d.SRO_HEIGHTFOG, d.SRO_OCEAN_SHORE], 'the ocean, fogged, with the shore').toEqual([true, true, true])
        yield { label: `${p}/${q.waves}/ripple ${ripple}`, cost, extraUnits: (RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0) + (SHORE_SAMPLERS.length ? 0 : 1) }
      } finally {
        material.dispose()
      }
    }
  },
}

/**
 * The registry. Lanes add theirs here (docs/WAVE_PLAN6.md D13):
 * - BT-P: the region batch's group material (SRO_TABLE, every define on: night cluster, shelter, cloud noise, wet map,
 *   ripples, fog ring; 4 object samplers, no 2D map, no new varying, F8);
 * - CST-O: the ocean per preset (Low Classic; Medium worker tile; High/Ultra GPU tile) with its reflection cube;
 * - GL-S / GL-F: the grass field (≤ the retail grass's varyings); GL-L: each life kind (≤ the retail grass's + 1);
 * - GRASS_FAR: the meadow ring (the grass skeleton: the field's varyings);
 * - W11-S: the `+sheen` cloth group (SRO_CLOTH_WIND), the PBR water with the town plugin (ripple points, the profile);
 * - TL-M: the town's puffs and leaves (thin instances with the instance colour);
 * - TL-C: the crowd's variant material (the VAT, thin instances with the instance colour, the fade, surface and fog);
 * - W12-SA: the wave-12 tree group (the tree plugin: SRO_FOL_PIVOT4, SRO_FOL_VDATA; T12-W: SRO_FOL_BAND).
 */
const MATERIALS: MaterialCase[] = [
  TERRAIN_PBR,
  WATER_PBR,
  BATCH_GROUP,
  // W11-S: the cloth group (the `+sheen` table group with SRO_CLOTH_WIND).
  CLOTH_GROUP,
  // W12-SA: the wave-12 tree group (the tree plugin's slots on the vec4 pivot and the wind data).
  TREE_GROUP,
  classicCase('terrain (Classic, every chunk)', terrainShaders(WORLD_SHADER_CHUNKS)),
  classicCase('water (Classic, every chunk)', waterShaders(WORLD_SHADER_CHUNKS)),
  classicCase('retail grass (Classic, every chunk)', scatterShaders(WORLD_SHADER_CHUNKS)),
  // GL-S / GL-F: the grass field; GL-S: the wildlife kinds (GL-L draws them), every chunk declared.
  classicCase('grass field (GRASS_LIFE, every chunk)', grassShaders(WORLD_SHADER_CHUNKS)),
  // GRASS_FAR: the meadow ring's tufts (the grass skeleton over its own window), every chunk declared.
  classicCase('grass meadow ring (GRASS_FAR, every chunk)', grassRingShaders(WORLD_SHADER_CHUNKS)),
  classicCase('life: butterflies and dragonflies (every chunk)', critterShaders(WORLD_SHADER_CHUNKS)),
  classicCase('life: birds (every chunk)', birdShaders(WORLD_SHADER_CHUNKS)),
  classicCase('life: fireflies', fireflyShaders()),
  // CST-O: the ocean on the PBR presets, and Low's Classic ocean (the retail frames and the coast field, + the shore's).
  OCEAN_PBR,
  classicCase('ocean (Classic, CST-O: Low)', { ...classicOceanShaders(), uniforms: [], samplers: [...CLASSIC_OCEAN_SAMPLERS, ...SHORE_SAMPLERS], chunkSamplers: [] } as unknown as ShaderSources),
  // BT-S: the batch's cut-out caster (shadow pass only: the albedo atlas and the material table).
  classicCase('cut-out caster (BT-S, shadow depth)', cutoutCasterShaders()),
  // TL-M: the town's puffs and leaves.
  TOWN_FX,
  // TL-C: the crowd's variant material.
  TOWN_CROWD,
]

// ---- texture arrays -------------------------------------------------------------------------------------------------

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIELDS = join(REPO, 'work', 'out-opt', 'world', 'jangan-fields', 'manifest.json')

/** The terrain tile atlas: its first capacity, grown by 16 layers until every tile of the export fits. */
function tileAtlasLayers(tiles: number): number {
  const first = Math.max(...Object.values(STREAM_DEFAULTS).map(s => s.tileLayers))
  return Math.max(first, Math.ceil(tiles / 16) * 16)
}

interface ArrayCase {
  name: string
  layers(): number
}

/**
 * Every texture array and its most layers. Lanes add theirs (BT-A: the albedo and NRAO atlas pages, one per array, and
 * the 256²-layer lightmap array, 184 layers for jangan-fields, F7; CST-O: the FFT cascades).
 */
const ARRAYS: ArrayCase[] = [
  { name: 'terrain tier plane (TX-R)', layers: () => TILE_TIER_LAYERS },
  { name: 'terrain detail layers', layers: () => 3 },
  { name: 'terrain tiles, the synthetic worst (the atlas never exceeds the tile ids of a manifest: 1024 ids)', layers: () => tileAtlasLayers(0) },
  // BT-A: an atlas array never takes a page past MAX_ARRAY_LAYERS (the allocator's cap; the table refuses a slot rather
  // than spill); jangan-fields needs ≈ 36 albedo pages of 1024² in all (F6).
  { name: 'batch albedo atlas (BT-A, 1024² pages, per array)', layers: () => MAX_ARRAY_LAYERS },
  { name: 'batch NRAO atlas (BT-A, 1024² pages, per array)', layers: () => MAX_ARRAY_LAYERS },
  // F7: 490 × 128², 51 × 256², 35 × 64², 1 × 512² and the white quadrant, in 256² layers.
  { name: 'batch lightmap array (BT-A, 256² layers, jangan-fields: 184)', layers: () => lightmapLayers([...Array(490).fill(128), ...Array(51).fill(256), ...Array(35).fill(64), 512]) },
  // CST-O: the wave arrays (displacement + derivatives per cascade; the worker tile holds two ticks).
  { name: 'ocean waves, the worker tile (CST-O: 2 ticks × 2 × 2 cascades)', layers: () => 2 * 2 * WORKER_TILES_M.length },
  { name: 'ocean waves, the GPU FFT (CST-O: 2 × 4 cascades)', layers: () => 2 * GPU_TILES_M.length },
]

// ---- the guard --------------------------------------------------------------------------------------------------------

describe('material budgets (D13): WebGL2 units ≤ 16, inter-stage ≤ 15 user + front_facing', () => {
  for (const c of MATERIALS) {
    it(c.name, async () => {
      let worst = { units: 0, varyings: 0, what: '' }
      let n = 0
      for await (const s of c.sets()) {
        n++
        const units = s.cost.units + s.extraUnits
        expect(units, `${c.name} ${s.label}: texture units`).toBeLessThanOrEqual(MAX_UNITS)
        expect(s.cost.varyings.user, `${c.name} ${s.label}: user varyings`).toBeLessThanOrEqual(MAX_USER_VARYINGS)
        expect(s.cost.varyings.total, `${c.name} ${s.label}: inter-stage variables`).toBeLessThanOrEqual(MAX_INTER_STAGE)
        if (units > worst.units) worst = { ...worst, units, what: s.label }
        worst.varyings = Math.max(worst.varyings, s.cost.varyings.total)
      }
      expect(n).toBeGreaterThan(0)
      console.info(`[budgets] ${c.name}: ${n} sets, worst ${worst.units} units (${worst.what}), ${worst.varyings} inter-stage`)
    }, 300_000)
  }

  it('the terrain case holds the wave\'s worst: Ultra with full weather, arrays, every extern and both wave-10 defines', async () => {
    const r = rig()
    const feats = resolveTerrainFeatures({
      quality: RENDER_PRESETS.ultra, sky: SKY_PRESETS.ultra, weather: WEATHER_PRESETS.ultra, arrays: { normal: true, ormh: true, tier: true },
      externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true },
      defines: { has: n => n === COAST_WET_DEFINE || n === GRASS_TINT_DEFINE },
    })
    expect([feats.coastWet, feats.grassTint, feats.shelter, feats.wet]).toEqual([true, true, true, true])
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    const cost = await terrainCost(r, feats, terrainExterns(), { fog, quality: RENDER_PRESETS.ultra })
    expect(cost.units + 2).toBeGreaterThanOrEqual(15)
    expect(cost.units + 2).toBeLessThanOrEqual(MAX_UNITS)
  }, 120_000)

  it('the counter matches the one the game runs (a lightmapped CSM receiver: 15 + front_facing = 16)', () => {
    const names = Array.from({ length: 15 }, (_, i) => `v${i}`)
    expect(wgslStruct(names, true)).toEqual({ user: 15, builtins: 1, total: 16 })
    expect(wgslStruct(names, false).total).toBe(15)
  })
})

describe('texture arrays (D13): every array ≤ 256 layers', () => {
  for (const a of ARRAYS) {
    it(a.name, () => {
      expect(a.layers()).toBeGreaterThan(0)
      expect(a.layers()).toBeLessThanOrEqual(MAX_LAYERS)
    })
  }

  it.skipIf(!existsSync(FIELDS))('jangan-fields: the terrain tile atlas and the water frames fit', () => {
    const m = JSON.parse(readFileSync(FIELDS, 'utf8')) as { tiles: unknown[]; water: { frames: unknown[] } }
    expect(tileAtlasLayers(m.tiles.length)).toBeLessThanOrEqual(MAX_LAYERS)
    expect(m.water.frames.length).toBeLessThanOrEqual(MAX_LAYERS)
  })

  it.skipIf(!existsSync(join(dirname(FIELDS), 'lightmaps')))('jangan-fields: every object lightmap fits the batch lightmap array (BT-A, F7)', () => {
    const dir = join(dirname(FIELDS), 'lightmaps')
    const sizes: number[] = []
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!/\.(webp|png|jpe?g)$/i.test(f)) continue
      const size = encodedSize(readFileSync(join(dir, f)))
      expect(size, f).not.toBeNull()
      sizes.push(Math.max(size!.width, size!.height))
    }
    expect(sizes.length).toBeGreaterThan(0)
    expect(lightmapLayers(sizes)).toBeLessThanOrEqual(MAX_LAYERS)
  })
})


/**
 * TT-Q (TERRAIN_TEX §4.3, D9; WAVE_PLAN8 D14): Medium gets the detail layer (one unit) and anti-tiling (none: it reuses
 * the tile array). Medium's worst terrain set as the stream builds it (ORMH, no layer normals: layerNormals is High+,
 * no tier plane: the stream allocates it only past 16 units on High/Ultra) with full weather, the coast field and the
 * night cluster stays within WebGL2's 16 units: 14. The tier plane on top (never on Medium) would still fit.
 */
describe('TT-Q: Medium detail + anti-tiling within the WebGL2 16 units', () => {
  it('the worst Medium set is 14 units (≤ 16), with the detail layer and anti-tiling on', async () => {
    const r = rig()
    const q = RENDER_PRESETS.medium
    const feats = resolveTerrainFeatures({
      quality: q, sky: SKY_PRESETS.medium, weather: WEATHER_PRESETS.ultra, arrays: { normal: true, ormh: true, tier: false },
      externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true },
      defines: { has: n => n === COAST_WET_DEFINE || n === GRASS_TINT_DEFINE },
    })
    expect([feats.detail, feats.antiTiling, feats.normals, feats.tier, feats.ormh, feats.wet, feats.ripples, feats.shelter, feats.coastWet])
      .toEqual([true, true, false, false, true, true, true, true, true])
    expect(terrainUnits(feats, q.fog === 'height' && q.horizonRingFog)).toBe(14)
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    const cost = await terrainCost(r, feats, terrainExterns(), { fog, quality: q })
    const units = cost.units + (q.nightLights.cluster > 0 ? 2 : 0)
    expect(units).toBeLessThanOrEqual(MAX_UNITS)
    expect(units).toBeLessThanOrEqual(14)
    const tiered = resolveTerrainFeatures({
      quality: q, sky: SKY_PRESETS.medium, weather: WEATHER_PRESETS.ultra, arrays: { normal: true, ormh: true, tier: true },
      externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true },
      defines: { has: n => n === COAST_WET_DEFINE || n === GRASS_TINT_DEFINE },
    })
    const tCost = await terrainCost(r, tiered, terrainExterns(), { fog, quality: q })
    expect(tCost.units + 2).toBeLessThanOrEqual(MAX_UNITS)
  }, 120_000)
})

/**
 * T12-W (TREES §W8.2, WAVE_PLAN8 D14): the wave-12 chunks add no varying and no fragment unit. The Medium leaf tree group
 * (cut-out, every surface define, fog with its ring, the night cluster) with VDATA + BAND + the vec4 pivot has the
 * same `wgslInterStageCount` and the same WebGL2 fragment units as the wave-10 tree group (the vec3 pivot, no wind
 * data, no band): the band sampler and the wind data live in the vertex stage only.
 */
describe('T12-W: VDATA + BAND add no varying and no fragment unit (Medium leaf tree group)', () => {
  it('the inter-stage count and the fragment units equal the wave-10 tree group\'s, on every PBR preset', async () => {
    const cost = async (p: RenderPreset, wave12: boolean): Promise<{ cost: Cost; d: Record<string, unknown> }> => {
      const r = rig()
      r.tex.getInternalTexture()!.isReady = true
      r.tex.isReady = () => true
      const n = r.mesh.getTotalVertices()
      r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
      const floats = wave12 ? TREE_PIVOT_FLOATS : 3
      r.mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * floats).fill(1), false, floats)
      if (wave12) r.mesh.setVerticesData(FOLIAGE_TREEW_KIND, new Float32Array(n * 4).fill(0.5), false, 4)
      const fog = new HeightFog(r.scene)
      fog.ring = r.tex
      fog.setActive(true, true)
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const mat = new PBRMaterial('batch:tree:leaf+cutout', r.scene)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      new SroSurfacePlugin(mat, shared, { cls: 'foliage', baked: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
      if (wave12) fol.setBand(r.tex)
      new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', tree: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      attachFogPlugin(mat, fog)
      const c = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
      return { cost: c, d: { ...(r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>) } }
    }
    for (const p of PRESETS) {
      const old = await cost(p, false)
      const now = await cost(p, true)
      expect([old.d.SRO_FOL_PIVOT, old.d.SRO_FOL_PIVOT4, old.d.SRO_FOL_VDATA, old.d.SRO_FOL_BAND], `${p} wave 10`).toEqual([true, false, false, false])
      expect([now.d.SRO_FOL_PIVOT, now.d.SRO_FOL_PIVOT4, now.d.SRO_FOL_VDATA, now.d.SRO_FOL_BAND], `${p} wave 12`).toEqual([true, true, true, true])
      expect(now.cost.varyings, `${p}: inter-stage`).toEqual(old.cost.varyings)
      expect(now.cost.units, `${p}: fragment units`).toBe(old.cost.units)
      expect(now.cost.varyings.user, `${p}: user varyings`).toBeLessThanOrEqual(MAX_USER_VARYINGS)
    }
  }, 120_000)
})

/**
 * T12-N (TREES §W3.4, WAVE_PLAN8 D14, §5.3): the LOD0 overlay's table material (trees/near-field.ts: the batch's tree
 * recipe, thin instances, the species' wind data, the per-instance tint) adds no varying and no fragment unit: the
 * Medium leaf material with `SroTreeTintPlugin` and the `sroTint` instance buffer has the same `wgslInterStageCount`
 * and the same WebGL2 fragment units as without (the tint is one vertex-stage attribute added to uv2).
 */
describe('T12-N: the overlay\'s per-instance tint adds no varying and no fragment unit (thin-instanced leaf)', () => {
  it('the inter-stage count and the fragment units equal the untinted overlay\'s, on every PBR preset', async () => {
    const { SroTreeTintPlugin, TREE_TINT_KIND } = await import('../src/trees/near-field.ts')
    const cost = async (p: RenderPreset, tint: boolean): Promise<{ cost: Cost; d: Record<string, unknown> }> => {
      const r = rig()
      r.tex.getInternalTexture()!.isReady = true
      r.tex.isReady = () => true
      const n = r.mesh.getTotalVertices()
      r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
      r.mesh.setVerticesData(FOLIAGE_TREEW_KIND, new Float32Array(n * 4).fill(0.5), false, 4)
      r.mesh.thinInstanceSetBuffer('matrix', Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 16, false)
      if (tint) r.mesh.thinInstanceSetBuffer(TREE_TINT_KIND, new Float32Array([2]), 1, false)
      const fog = new HeightFog(r.scene)
      fog.ring = r.tex
      fog.setActive(true, true)
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const mat = new PBRMaterial('batch:tree:leaf+cutout', r.scene)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      new SroSurfacePlugin(mat, shared, { cls: 'foliage', baked: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
      const fol = new FoliageShared()
      Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
      fol.setBand(r.tex)
      new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', tree: true, breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
      new SroTreeTintPlugin(mat)
      attachFogPlugin(mat, fog)
      const c = await compileCost(r, mat, RENDER_PRESETS[p].nightLights.cluster > 0)
      // the tint lands in the vertex code (its injection point exists in Babylon's PBR vertex shader)
      const vs = (r.mesh.subMeshes[0]!.effect as unknown as { _vertexSourceCode: string })._vertexSourceCode
      expect(vs.includes(`uv2Updated.y += ${TREE_TINT_KIND};`), `${p}: the tint line`).toBe(true)
      return { cost: c, d: { ...(r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>) } }
    }
    for (const p of PRESETS) {
      const plain = await cost(p, false)
      const tinted = await cost(p, true)
      expect([plain.d.SRO_TREE_TINT, plain.d.SRO_FOL_VDATA, plain.d.SRO_FOL_BAND, plain.d.THIN_INSTANCES], `${p} untinted`).toEqual([false, true, false, true])
      expect([tinted.d.SRO_TREE_TINT, tinted.d.SRO_FOL_VDATA, tinted.d.SRO_FOL_BAND, tinted.d.THIN_INSTANCES], `${p} tinted`).toEqual([true, true, false, true])
      expect(tinted.cost.varyings, `${p}: inter-stage`).toEqual(plain.cost.varyings)
      expect(tinted.cost.units, `${p}: fragment units`).toBe(plain.cost.units)
      expect(tinted.cost.varyings.user, `${p}: user varyings`).toBeLessThanOrEqual(MAX_USER_VARYINGS)
      expect(tinted.cost.units, `${p}: units`).toBeLessThanOrEqual(MAX_UNITS)
    }
  }, 120_000)
})

describe('UV scroll: the retail scroll plugin adds no varying and no fragment unit (uv-scroll.ts)', () => {
  /** A converted object material like a lightmapped, cut-out retail piece; `scroll`: with the plugin. */
  const objectCost = async (p: RenderPreset | 'classic', scroll: boolean): Promise<{ cost: Cost; vs: string; d: Record<string, unknown> }> => {
    const { SroUvScrollPlugin, UvScrollShared } = await import('../src/uv-scroll.ts')
    const r = rig()
    r.tex.getInternalTexture()!.isReady = true
    r.tex.isReady = () => true
    const n = r.mesh.getTotalVertices()
    r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
    const lm = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, r.scene)
    lm.coordinatesIndex = 1
    lm.getInternalTexture()!.isReady = true
    lm.isReady = () => true
    let mat: Material
    if (p === 'classic') {
      const std = new StandardMaterial(`object:classic${scroll ? '+scroll' : ''}`, r.scene)
      std.diffuseTexture = r.tex
      std.lightmapTexture = lm
      std.useLightmapAsShadowmap = true
      std.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST
      std.backFaceCulling = false
      std.twoSidedLighting = true
      mat = std
    } else {
      const fog = new HeightFog(r.scene)
      fog.ring = r.tex
      fog.setActive(true, true)
      const shared = new SurfaceShared()
      shared.wet = true
      shared.puddles = true
      shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
      shared.cloud = new Vector4(1, 1, 1, 1)
      shared.cloudProj = new Vector4(1, 1, 1, 1)
      shared.cloudNoise = r.tex
      const pbr = new PBRMaterial(`object:${p}${scroll ? '+scroll' : ''}`, r.scene)
      pbr.albedoTexture = r.tex
      pbr.lightmapTexture = lm
      pbr.useLightmapAsShadowmap = true
      pbr.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      pbr.backFaceCulling = false
      pbr.twoSidedLighting = true
      new SroSurfacePlugin(pbr, shared, { cls: 'stone', baked: true, selfLit: true })
      attachFogPlugin(pbr, fog)
      mat = pbr
    }
    if (scroll) new SroUvScrollPlugin(mat, new UvScrollShared(r.scene), [0, -2.78])
    try {
      const cost = await compileCost(r, mat, p !== 'classic' && RENDER_PRESETS[p].nightLights.cluster > 0)
      const vs = (r.mesh.subMeshes[0]!.effect as unknown as { _vertexSourceCode: string })._vertexSourceCode
      return { cost, vs, d: { ...(r.mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>) } }
    } finally {
      mat.dispose()
      lm.dispose()
    }
  }

  it('a lightmapped cut-out object (PBR on every preset, and Classic): the same inter-stage count and units with the scroll', async () => {
    for (const p of [...PRESETS, 'classic'] as const) {
      const plain = await objectCost(p, false)
      const scrolled = await objectCost(p, true)
      expect([plain.d.SRO_UVSCROLL, scrolled.d.SRO_UVSCROLL, scrolled.d.UV1, scrolled.d.MAINUV1], `${p}: defines`).toEqual([undefined, true, true, true])
      // The offset lands on uvUpdated before Babylon writes vMainUV1 (no texture matrix, no new varying).
      const at = scrolled.vs.indexOf('uvUpdated += sroUvScroll.xy;')
      expect(at, `${p}: the scroll line`).toBeGreaterThan(0)
      expect(scrolled.vs.indexOf('vMainUV1=uvUpdated', at), `${p}: before vMainUV1`).toBeGreaterThan(at)
      expect(scrolled.cost.varyings, `${p}: inter-stage`).toEqual(plain.cost.varyings)
      expect(scrolled.cost.units, `${p}: fragment units`).toBe(plain.cost.units)
      expect(scrolled.cost.varyings.total, `${p}: inter-stage ≤ 16`).toBeLessThanOrEqual(MAX_INTER_STAGE)
    }
  }, 120_000)
})
