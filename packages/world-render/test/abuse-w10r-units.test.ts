/**
 * Wave 10r adversarial hunt, lens "units": WebGL2 texture units (16) with night + rain + clouds + the coast wet band +
 * the grass tint + a batch group.
 */
import { DirectionalLight, MeshBuilder, NullEngine, RawTexture, Scene, SphericalPolynomial, Vector3, Vector4, type Material, type Mesh } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterAll, describe, expect, it } from 'vitest'
import { COAST_WET_DEFINE, GRASS_TINT_DEFINE, RENDER_PRESETS, SKY_PRESETS, WEATHER_PRESETS, type RenderPreset, type WeatherLevel } from '../src/index.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { TerrainPbr, defaultTerrainExterns, featureKey, resolveTerrainFeatures, type TerrainFeatures } from '../src/pbr/terrain-plugin.ts'

const MAX_UNITS = 16

interface Rig { engine: NullEngine; scene: Scene; mesh: Mesh; tex: RawTexture }
const rigs: Rig[] = []
afterAll(() => {
  for (const r of rigs.splice(0)) r.engine.dispose()
})

/** material-budgets.test.ts's rig: a CSM receiver on light 0, an SH environment, textureLOD. */
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

/** The distinct samplers of the preprocessed WebGL2 fragment shader. */
async function fragmentSamplers(r: Rig, material: Material): Promise<string[]> {
  r.mesh.material = material
  let ready = false
  for (let i = 0; i < 600 && !ready; i++) {
    ready = material.isReadyForSubMesh(r.mesh, r.mesh.subMeshes[0]!)
    if (!ready) await new Promise(res => setTimeout(res, 5))
  }
  expect(ready, `${material.name} compiles`).toBe(true)
  const effect = r.mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  let frag = ''
  PreProcess(effect._fragmentSourceCode, { defines, isFragment: true, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => { frag = c }, r.engine)
  return [...new Set([...frag.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler\w+\s+(\w+)/g)].map(m => m[1]!))]
}

async function terrainSamplers(r: Rig, feats: TerrainFeatures): Promise<string[]> {
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), defaultTerrainExterns())
  pbr.setFeatures(feats)
  pbr.tiles = pbr.normals = pbr.ormh = pbr.tilesHi = r.tex
  const { material } = pbr.createMaterial('terrain', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
  try {
    return await fragmentSamplers(r, material)
  } finally {
    material.dispose()
    pbr.dispose()
  }
}

const PRESETS: readonly RenderPreset[] = ['medium', 'high', 'ultra']
const LEVELS: readonly WeatherLevel[] = ['off', 'low', 'medium', 'ultra']

describe('PBR terrain: every reachable feature set fits 16 WebGL2 units (the night cluster\'s 2 included)', () => {
  it('with the three map arrays arriving independently (terrain.ts sets normalArray / ormhArray / tierArray one by one)', async () => {
    const r = rig()
    const seen = new Map<string, number>()
    const over: string[] = []
    for (const p of PRESETS) for (const l of LEVELS) for (let a = 0; a < 8; a++) for (let d = 0; d < 8; d++) {
      const arrays = { normal: !!(a & 1), ormh: !!(a & 2), tier: !!(a & 4) }
      const defs = new Set<string>([...(d & 1 ? ['SRO_NIGHT_SPLAT'] : []), ...(d & 2 ? [COAST_WET_DEFINE] : []), ...(d & 4 ? [GRASS_TINT_DEFINE] : [])])
      const feats = resolveTerrainFeatures({
        quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[l], arrays,
        externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true }, defines: { has: n => defs.has(n) },
      })
      const key = featureKey(feats)
      let n = seen.get(key)
      if (n === undefined) {
        const s = await terrainSamplers(r, feats)
        n = s.length
        seen.set(key, n)
        if (n + 2 > MAX_UNITS) over.push(`${p}/${l}/normals ${arrays.normal}/ormh ${arrays.ormh}/tier ${arrays.tier}/night ${!!(d & 1)}/coast ${!!(d & 2)}/tint ${!!(d & 4)}: ${n} + 2 cluster [${s.join(', ')}]`)
      }
    }
    expect(over).toEqual([])
  }, 300_000)
})

/**
 * Finding U-1. RENDER_PRESETS High/Ultra run the height fog with its horizon ring (fog 'height', horizonRingFog), and
 * HeightFog.setActive attaches SroFogPlugin (its `sroFogRing` sampler under SRO_FOG_RING) to EVERY PBR material of the
 * scene, the PBR terrain included (terrain.ts: "RND-P's height fog replaces it on PBR materials"). material-budgets'
 * TERRAIN_PBR case never attaches the fog plugin, so D13 counts the terrain one unit short: it reports a worst of 16
 * (cluster included) where the real program needs 17, and COAST F16's FULL_SET fallback was sized on that count.
 * Browser (WebGL2 Ultra, weather ultra, ANGLE D3D11 MAX_TEXTURE_IMAGE_UNITS 16): the live terrain effect already holds
 * exactly 16 samplers (environmentBrdf, reflection, sroTiles, sroLayerMap, sroLightmap, sroNormals, sroOrmh, sroDetail,
 * sroWetMap, sroRipple, wxOccMap, cloudNoise, sroFogRing, shadowTexture0, lightDataTexture1, tileMaskTexture1): no
 * headroom; any texture set that also brings the tier plane (sroTilesHi: High/Ultra with a '2x' tier larger than the
 * base) is 17 and the terrain program fails to link on WebGL2 (the terrain vanishes).
 */
describe('U-1: PBR terrain + the height fog\'s horizon ring (High/Ultra) fits 16 WebGL2 units', () => {
  it('every High/Ultra set with the ring attached, as the scene attaches it (fails: 17 with the tier plane and the map arrays)', async () => {
    const r = rig()
    const fog = new HeightFog(r.scene)
    fog.ring = r.tex
    fog.setActive(true, true)
    const over: string[] = []
    const seen = new Set<string>()
    for (const p of ['high', 'ultra'] as const) {
      expect([RENDER_PRESETS[p].fog, RENDER_PRESETS[p].horizonRingFog, RENDER_PRESETS[p].nightLights.terrainSplat]).toEqual(['height', true, false])
      for (const l of LEVELS) for (let a = 0; a < 8; a++) for (let d = 0; d < 4; d++) {
        const arrays = { normal: !!(a & 1), ormh: !!(a & 2), tier: !!(a & 4) }
        // No night splat on High/Ultra (NightLightQuality.terrainSplat is Low only).
        const defs = new Set<string>([...(d & 1 ? [COAST_WET_DEFINE] : []), ...(d & 2 ? [GRASS_TINT_DEFINE] : [])])
        const feats = resolveTerrainFeatures({
          quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS[l], arrays,
          externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true }, defines: { has: n => defs.has(n) },
        })
        const key = `${p}:${featureKey(feats)}`
        if (seen.has(key)) continue
        seen.add(key)
        const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), defaultTerrainExterns())
        pbr.setFeatures(feats)
        pbr.tiles = pbr.normals = pbr.ormh = pbr.tilesHi = r.tex
        const { material } = pbr.createMaterial('terrain', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
        // What the scene does for a material made after setActive (the registered factory does the same).
        attachFogPlugin(material, fog)
        const s = await fragmentSamplers(r, material)
        material.dispose()
        pbr.dispose()
        if (s.length + 2 > MAX_UNITS) over.push(`${p}/weather ${l}/normals ${arrays.normal}/ormh ${arrays.ormh}/tier ${arrays.tier}/coast ${!!(d & 1)}/tint ${!!(d & 2)}: ${s.length} + 2 cluster [${s.join(', ')}]`)
      }
    }
    expect(over).toEqual([])
  }, 300_000)
})
