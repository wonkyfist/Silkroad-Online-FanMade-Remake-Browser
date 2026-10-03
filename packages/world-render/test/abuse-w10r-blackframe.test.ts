/**
 * Wave 10r adversarial hunt, lens "blackframe": a black WebGPU frame at any preset with a batch, the grass, the life
 * and the sea in one view, also with `?gpuLimits=default` (16 inter-stage variables, 256 layers).
 *
 * WebGPU drops the whole frame when one pipeline in it is invalid; the commonest cause in this project is a lit PBR
 * material that needs more than `maxInterStageShaderVariables` (16 on `?gpuLimits=default`, where post.ts already turns
 * the prepass off). material-budgets.test.ts (D13) is the guard every wave-10 lane registers with. Its inter-stage
 * counter reads the preprocessed GLSL varyings with a regex that needs `name;`, so the CSM receiver's array varyings
 * (`varying vec4 vPositionFromLight0[SHADOWCSMNUM_CASCADES0];`, `varying float vDepthMetric0[...]`) never match. On
 * WGSL Babylon unrolls them to a fixed 4 + 4 members (lightUboDeclaration: `vPositionFromLight{X}_0.._3`,
 * `vDepthMetric{X}_0.._3`), whatever the cascade count. The guard prints "4 inter-stage" for the Ultra terrain and "6"
 * for the batch group: it is blind to 8 of the varyings every CSM receiver has, plus the cluster's `vViewDepth`
 * (CLUSTLIGHT_BATCH, Medium and up), so a lane that adds 2 varyings to a CSM receiver passes D13 and drops the frame.
 */
import { DirectionalLight, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, SphericalPolynomial, Vector3, Vector4, type Material, type Mesh } from '@babylonjs/core'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { afterAll, describe, expect, it } from 'vitest'
import { COAST_WET_DEFINE, GRASS_TINT_DEFINE, RENDER_PRESETS, SKY_PRESETS, WEATHER_PRESETS, wgslInterStageCount, type InterStageCount, type RenderPreset } from '../src/index.ts'
import { TerrainPbr, defaultTerrainExterns, resolveTerrainFeatures } from '../src/pbr/terrain-plugin.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { FOLIAGE_MIN_BREEZE, FOLIAGE_PIVOT_KIND, FoliageShared, SroFoliagePlugin } from '../src/pbr/foliage-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import { CDLOD_MAX_NODES } from '../src/ocean/cdlod.ts'
import { CDLOD_ATTRIBUTE, OceanPbrState, createOceanMaterial } from '../src/ocean/ocean-plugin.ts'
import { interStageNames } from './inter-stage.ts'

const MAX_INTER_STAGE = 16

interface Rig { engine: NullEngine; scene: Scene; mesh: Mesh; tex: RawTexture }
const rigs: Rig[] = []
afterAll(() => {
  for (const r of rigs.splice(0)) r.engine.dispose()
})

/** material-budgets.test.ts's rig (a CSM receiver on light 0, an SH environment), with the preset's cascade count. */
function rig(cascades: number): Rig {
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
      d[`SHADOWCSMNUM_CASCADES${i}`] = cascades
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
  tex.getInternalTexture()!.isReady = true
  tex.isReady = () => true
  const r = { engine, scene, mesh, tex }
  rigs.push(r)
  return r
}

async function compiled(r: Rig, mesh: Mesh, material: Material): Promise<{ vert: string; frag: string }> {
  mesh.material = material
  let ready = false
  for (let i = 0; i < 600 && !ready; i++) {
    ready = material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)
    if (!ready) await new Promise(res => setTimeout(res, 5))
  }
  expect(ready, `${material.name} compiles`).toBe(true)
  const effect = mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string; _vertexSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  const pre = (code: string, isFragment: boolean): string => {
    let out = ''
    PreProcess(code, { defines, isFragment, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => { out = c }, r.engine)
    return out
  }
  return { vert: pre(effect._vertexSourceCode, false), frag: pre(effect._fragmentSourceCode, true) }
}

/**
 * The names the D13 guard counts (material-budgets.test.ts `varyingsOf` through inter-stage.ts; BF-1 fixed: on e192530
 * it was a regex that missed the CSM arrays, kept here before the fix).
 */
function budgetsNames(vertexGlsl: string): string[] {
  return interStageNames(vertexGlsl, false)
}

/**
 * The WGSL FragmentInputs Babylon writes for the same shader: every GLSL varying, arrays included; the CSM arrays are
 * the fixed 4 members WGSL's lightUboDeclaration declares (vPositionFromLight{X}_0.._3, vDepthMetric{X}_0.._3); a matN
 * is N locations. `cluster` adds `vViewDepth` (CLUSTLIGHT_BATCH > 0, pbrFragmentExtraDeclaration), which a scene with
 * the preset's ClusteredLightContainer adds to every lit PBR material and the NullEngine rig cannot make.
 */
function wgslFaithful(vert: string, frag: string, cluster: boolean): { names: string[]; count: InterStageCount } {
  const names: string[] = []
  for (const m of vert.matchAll(/(?:^|;|\n)\s*(?:flat\s+)?(?:varying|out)\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec[234]|mat[234]|int|ivec[234]|uint|uvec[234])\s+(\w+)\s*(\[[^\]]+\])?\s*;/g)) {
    const [, type, name, arr] = m as unknown as [string, string, string, string | undefined]
    if (name === 'glFragColor') continue
    const per = /^mat(\d)$/.exec(type) ? Number(type[3]) : 1
    const n = arr ? (/^(vPositionFromLight|vDepthMetric)\d+$/.test(name) ? 4 : Number(/\d+/.exec(arr)?.[0] ?? 4)) : 1
    for (let i = 0; i < n * per; i++) names.push(n * per > 1 ? `${name}_${i}` : name)
  }
  if (cluster && !names.includes('vViewDepth')) names.push('vViewDepth')
  const unique = [...new Set(names)]
  const members = unique.map((n, i) => `  @location(${i}) ${n}: vec4f,`).join('\n')
  const front = /\bgl_FrontFacing\b/.test(frag)
  const body = `struct FragmentInputs {\n  @builtin(position) position: vec4<f32>,\n${members}\n};\nfn main(input: FragmentInputs) {${front ? ' let f = fragmentInputs.frontFacing;' : ''} }`
  return { names: unique, count: wgslInterStageCount(body) }
}

const fogOf = (r: Rig) => {
  const fog = new HeightFog(r.scene)
  fog.ring = r.tex
  fog.setActive(true, true)
  return fog
}

/** BT-P's group material as the budgets case builds it (every define on), on a mesh with uv2 and the pivot. */
async function batchGroup(r: Rig) {
  const n = r.mesh.getTotalVertices()
  r.mesh.setVerticesData('uv2', new Float32Array(n * 2).fill(0.5), false, 2)
  r.mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * 3), false, 3)
  const shared = new SurfaceShared()
  shared.wet = true
  shared.puddles = true
  shared.shelter = { texture: r.tex, packed: false } as unknown as SurfaceShared['shelter']
  shared.cloud = new Vector4(1, 1, 1, 1)
  shared.cloudProj = new Vector4(1, 1, 1, 1)
  shared.cloudNoise = r.tex
  const mat = new PBRMaterial('batch:cutout', r.scene)
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  new SroSurfacePlugin(mat, shared, { cls: 'foliage', baked: true, lamp: true, selfLit: true, table: { albedo: r.tex, nrao: r.tex, lightmap: r.tex, table: r.tex } })
  const fol = new FoliageShared()
  Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
  new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
  attachFogPlugin(mat, fogOf(r))
  return compiled(r, r.mesh, mat)
}

/** CST-O's ocean on a High/Ultra row (GPU tile, CSM received), fogged, with the shore lace and the ripples. */
async function ocean(r: Rig) {
  const probe = MeshBuilder.CreateGround('oceanProbe', { width: 1, height: 1, subdivisions: 2 }, r.scene)
  const m = new Float32Array(CDLOD_MAX_NODES * 16)
  for (let i = 0; i < CDLOD_MAX_NODES; i++) m.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16)
  probe.thinInstanceSetBuffer('matrix', m, 16, true)
  probe.thinInstanceSetBuffer(CDLOD_ATTRIBUTE, new Float32Array(CDLOD_MAX_NODES * 4), 4, false)
  probe.thinInstanceCount = 4
  probe.receiveShadows = true
  const st = new OceanPbrState()
  st.waves = st.field = st.normal = st.frames = r.tex
  const sv = new Vector4(0, 9, 0.4, 0.5)
  st.shore = { ready: true, update() {}, bind(b) { b.vec4('sroShoreA', sv); b.vec4('sroShoreB', sv); b.texture('sroShoreLace', r.tex) }, dispose() {} }
  st.setSwitches({ lerp: false, cascades4: true, ripple: r.tex })
  const { material } = createOceanMaterial(r.scene, st)
  attachFogPlugin(material, fogOf(r))
  return compiled(r, probe, material)
}

/** RND-T's terrain with every wave-10 extern and define on (Ultra, full weather, arrays). */
async function terrain(r: Rig, p: RenderPreset) {
  const feats = resolveTerrainFeatures({
    quality: RENDER_PRESETS[p], sky: SKY_PRESETS[p], weather: WEATHER_PRESETS.ultra, arrays: { normal: true, ormh: true, tier: p !== 'medium' },
    externs: { shelter: true, cloudShadow: true, nightSplat: true, coastWet: true, grassTint: true },
    defines: { has: n => n === COAST_WET_DEFINE || n === GRASS_TINT_DEFINE },
  })
  const pbr = new TerrainPbr(r.scene, new Map([['wxOcc', new Vector4(0, 0, 128, 1 / 128)]]), defaultTerrainExterns())
  pbr.setFeatures(feats)
  pbr.tiles = pbr.normals = pbr.ormh = pbr.tilesHi = r.tex
  const { material } = pbr.createMaterial('terrain', { originX: 0, originZ: 0, layerCount: 1, layerMap: r.tex, lightmap: null, textures: {} })
  return compiled(r, r.mesh, material)
}

const PBR_CASES = [
  { name: 'region batch group', build: batchGroup, presets: ['medium', 'high', 'ultra'] as RenderPreset[] },
  { name: 'ocean (GPU tile)', build: ocean, presets: ['high', 'ultra'] as RenderPreset[] },
  { name: 'terrain', build: (r: Rig) => terrain(r, 'ultra'), presets: ['ultra'] as RenderPreset[] },
]

describe('D13 inter-stage guard sees the CSM receiver (material-budgets.test.ts varyingsOf)', () => {
  for (const c of PBR_CASES) {
    it(`${c.name}: the budgets counter counts every varying WGSL declares (the 8 CSM array members included)`, async () => {
      const r = rig(RENDER_PRESETS.high.shadows?.cascades ?? 4)
      const { vert, frag } = await c.build(r)
      const real = wgslFaithful(vert, frag, false)
      // The CSM receiver's 4 + 4 + 1 shadow varyings are in the real struct...
      expect(real.names.filter(n => /^vPositionFromLight0_|^vDepthMetric0_/.test(n))).toHaveLength(8)
      // ...and D13 must count them: it sees only the plain ones.
      expect(budgetsNames(vert).length, `${c.name}: budgets sees [${budgetsNames(vert).join(', ')}], WGSL has [${real.names.join(', ')}]`).toBe(real.names.length)
    }, 120_000)
  }
})

describe('wave-10 PBR materials fit 16 inter-stage variables (?gpuLimits=default, prepass off)', () => {
  for (const c of PBR_CASES) for (const p of c.presets) {
    it(`${c.name} on ${p} (the preset's cluster adds vViewDepth)`, async () => {
      const r = rig(RENDER_PRESETS[p].shadows?.cascades ?? 4)
      const { vert, frag } = await c.build(r)
      const { names, count } = wgslFaithful(vert, frag, RENDER_PRESETS[p].nightLights.cluster > 0)
      console.info(`[w10r-blackframe] ${c.name} ${p}: ${count.total} (${count.user} + ${count.builtins}) [${names.join(', ')}]`)
      expect(count.total, `${c.name} ${p}: [${names.join(', ')}]`).toBeLessThanOrEqual(MAX_INTER_STAGE)
    }, 120_000)
  }
})
