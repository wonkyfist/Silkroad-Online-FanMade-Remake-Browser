/**
 * TX-R's tier plane on the WebGL2 sampler budget (docs/WAVE_PLAN3.md D32, D39): with SRO_T_TIER the High and Ultra
 * terrain compiles (NullEngine PBRMaterial + SroTerrainPlugin, the same rig as terrain-plugin.test.ts) and every final
 * define set stays at ≤ 16 texture units, the clustered lights' two textures included. This rig (like
 * terrain-plugin.test.ts') has no fog plugin: in the game the fog ring adds one more unit on High, so High with the tier
 * reaches 17 on a 16-unit device, which is why the stream only allocates the tier plane where the engine reports more
 * than 16 units (WebGPU with setMaximumLimits). The players are on WebGL2 until the mini PC serves HTTPS.
 */
import { DirectionalLight, MeshBuilder, NullEngine, RawTexture, Scene, SphericalPolynomial, Vector3, Vector4, type Mesh } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterEach, describe, expect, it } from 'vitest'
import { TerrainPbr, defaultTerrainExterns, featureKey, parseExtern, resolveTerrainFeatures, type TerrainExterns, type TerrainFeatures } from '../src/pbr/terrain-plugin.ts'
import { RENDER_PRESETS, type RenderPreset } from '../src/render/quality.ts'
import { SKY_PRESETS } from '../src/sky/types.ts'
import { WEATHER_PRESETS, type WeatherLevel } from '../src/weather/presets.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const FAKE: TerrainExterns = {
  shelter: parseExtern('sroShelter',
    'uniform wxOcc: vec4f;\nvar wxOccMap: texture_2d<f32>;\nvar wxOccMapSampler: sampler;\nfn sroShelter(p: vec3f) -> f32 {\n  return textureSampleLevel(wxOccMap, wxOccMapSampler, (p.xz - uniforms.wxOcc.xy) * uniforms.wxOcc.w + vec2f(0.5), 0.0).r;\n}\n',
    'uniform vec4 wxOcc;\nuniform sampler2D wxOccMap;\nfloat sroShelter(vec3 p) {\n  return textureLod(wxOccMap, (p.xz - wxOcc.xy) * wxOcc.w + vec2(0.5), 0.0).r;\n}\n'),
  cloudShadow: parseExtern('sroCloudShadow',
    'uniform skyCloud: vec4f;\nvar skyCloudNoise: texture_2d<f32>;\nvar skyCloudNoiseSampler: sampler;\nfn sroCloudShadow(xz: vec2f) -> f32 {\n  return 1.0 - textureSampleLevel(skyCloudNoise, skyCloudNoiseSampler, xz * uniforms.skyCloud.x, 0.0).r * uniforms.skyCloud.y;\n}\n',
    'uniform vec4 skyCloud;\nuniform sampler2D skyCloudNoise;\nfloat sroCloudShadow(vec2 xz) {\n  return 1.0 - textureLod(skyCloudNoise, xz * skyCloud.x, 0.0).r * skyCloud.y;\n}\n'),
  nightSplat: defaultTerrainExterns().nightSplat,
}

function rig(): { engine: NullEngine; scene: Scene; mesh: Mesh; tex: RawTexture } {
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

async function samplers(r: ReturnType<typeof rig>, feats: TerrainFeatures): Promise<{ n: number; glsl: string }> {
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), FAKE)
  pbr.setFeatures(feats)
  pbr.tiles = pbr.normals = pbr.ormh = pbr.tilesHi = r.tex
  pbr.tierLayers = 16
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
  return { n: new Set([...glsl.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler\w+\s+(\w+)/g)].map(m => m[1]!)).size, glsl }
}

describe('D32 with the tier plane', () => {
  it('High and Ultra with SRO_T_TIER compile and take at most 17 texture units (16 without the tier) in every weather', async () => {
    const r = rig()
    const seen = new Map<string, number>()
    let worst = 0
    const presets: RenderPreset[] = ['high', 'ultra']
    const levels: WeatherLevel[] = ['off', 'low', 'medium', 'high', 'ultra']
    for (const p of presets) {
      for (const l of levels) {
        // The terrain night splat is Low/Medium only (D29), and the stream only allocates the tier plane where it is off.
        for (const night of RENDER_PRESETS[p].nightLights.terrainSplat ? [false, true] : [false]) {
          const feats = resolveTerrainFeatures({
            quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[l], arrays: { normal: true, ormh: true, tier: true },
            // A device with more than 16 units (the stream's rule for the tier; on 16 the resolver drops it, U-1).
            externs: { shelter: true, cloudShadow: true, nightSplat: true }, defines: { has: () => night }, maxUnits: 32,
          })
          expect(feats.tier).toBe(true)
          const key = featureKey(feats)
          let n = seen.get(key)
          if (n === undefined) {
            const s = await samplers(r, feats)
            expect(s.glsl).toContain('sroTilesHi')
            expect(s.glsl).toContain('sroTier.x')
            n = s.n
            seen.set(key, n)
          }
          // + the cluster's two textures, + the fog ring (RND-P's fog plugin, High+, not in this rig).
          const total = n + (RENDER_PRESETS[p].nightLights.cluster > 0 ? 2 : 0) + (RENDER_PRESETS[p].horizonRingFog ? 1 : 0)
          worst = Math.max(worst, total)
          // The tier costs one unit: it fits a device with more than 16 (the stream's rule), never more than 17.
          expect(total, `${p} weather ${l} night ${night}`).toBeLessThanOrEqual(17)
          const without = await samplers(r, { ...feats, tier: false })
          expect(without.n + total - n, `${p} weather ${l} night ${night} without the tier`).toBeLessThanOrEqual(16)
        }
      }
    }
    expect(worst).toBe(17)
  }, 180_000)
})
