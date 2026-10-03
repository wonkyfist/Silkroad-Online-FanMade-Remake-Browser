/**
 * W9 finish adversarial hunt, lens "blackframe" (vanishing meshes and black frames on WebGPU and WebGL2).
 *
 * The hotfix 4fae288's rule: no two plugins on one material may declare the same UBO member or sampler (Babylon joins
 * every plugin's members into one block; GLSL fails the whole program with "Duplicate field name in structure", so on
 * WebGL2 the mesh is skipped). WX-C's WetnessPlugin avoids the clash by leaving out what the RENDER wet plugins
 * declare (wet-plugin.ts RENDER_WET_PLUGINS / renderDeclared), but that list names only SroSurfacePlugin and
 * SroTerrainPlugin. RND-W's SroFoliagePlugin declares `wxA` and `wxB` too (the wind vectors `sroWind` reads), so a
 * material that carries both the wetness plugin and the foliage plugin declares them twice.
 *
 * Today no flow puts both on one material (ObjectMaterials.toPbr attaches the surface plugin before the decorators
 * run, and attachWetness skips a material with a surface plugin; the foliage decorator needs the surface plugin), so
 * this is the hotfix's bug class one reordering away, not a live failure.
 */
import { NullEngine, PBRMaterial, Scene, ShaderLanguage, type Material } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { FoliageShared, SroFoliagePlugin } from '../src/pbr/foliage-plugin.ts'
import { SroSurfacePlugin, SurfaceShared } from '../src/pbr/surface-plugin.ts'
import { attachWetness } from '../src/weather/wet-plugin.ts'
import { installEffectCacheFix } from '../src/render/babylon-fixes.ts'
import { installLinkSettle, settleProgram, wgslInterStageCount } from '../src/render/gpu-guards.ts'

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

/** The member names of a plugin UBO declaration, GLSL (`vec4 name;`) or WGSL (`uniform name: vec4f;`). */
function memberNames(decl: string): string[] {
  return decl
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => /^uniform\s+(\w+)\s*:/.exec(l)?.[1] ?? /^\w+\s+(\w+)/.exec(l)?.[1] ?? l)
}

const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]

/** Builds the material's uniform layout in `lang` and returns the UBO members its plugins declared. */
function declared(mat: Material, lang: ShaderLanguage): string[] {
  const m = mat as unknown as { _shaderLanguage: ShaderLanguage; buildUniformLayout(): void }
  const was = m._shaderLanguage
  m._shaderLanguage = lang
  try {
    m.buildUniformLayout()
  } finally {
    m._shaderLanguage = was
  }
  return memberNames((mat.pluginManager as unknown as { _uboDeclaration: string })._uboDeclaration)
}

describe('wetness + foliage plugins on one material', () => {
  it('declare every UBO member once in GLSL and WGSL (fails: wxA and wxB twice)', () => {
    const scene = nullScene()
    const mat = new PBRMaterial('tree_leaf', scene)
    // A static tree material wetted by WorldWeather's decorator first, then dressed by RND-M and RND-W.
    expect(attachWetness(mat, 'static', { foliage: true })).not.toBeNull()
    new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'foliage' })
    new SroFoliagePlugin(mat, new FoliageShared(), { leaf: true, kind: 'static' })
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      expect(dupes(declared(mat, lang)), lang === ShaderLanguage.WGSL ? 'WGSL' : 'GLSL').toEqual([])
    }
  })
})

describe('BF-1 / BF-2 guards (render/gpu-guards.ts)', () => {
  it('counts the inter-stage variables Chrome counts: the @location members plus front_facing when read', () => {
    // The shape Babylon's WGSL processor writes for a lightmapped CSM receiver on Medium (the finding's CJ_w_stair).
    const names = ['vMainUV1', 'vMainUV2', 'vPositionW', 'vNormalW', 'vEnvironmentIrradiance',
      'vPositionFromLight0_0', 'vPositionFromLight0_1', 'vPositionFromLight0_2', 'vPositionFromLight0_3',
      'vDepthMetric0_0', 'vDepthMetric0_1', 'vDepthMetric0_2', 'vDepthMetric0_3', 'vPositionFromCamera0', 'vViewDepth']
    const struct = `struct FragmentInputs {\n  @builtin(position) position : vec4<f32>,\n  @builtin(front_facing) frontFacing : bool,\n${names.map((n, i) => `  @location(${i}) ${n} : vec4<f32>,`).join('\n')}\n};\nvar<private> fragmentInputs : FragmentInputs;\n`
    const reads = 'fn main() { let f = select(-1.0, 1.0, fragmentInputs.frontFacing); }'
    expect(wgslInterStageCount(struct + reads)).toEqual({ user: 15, builtins: 1, total: 16 })
    // Not read: Tint does not count it.
    expect(wgslInterStageCount(struct + 'fn main() {}').total).toBe(15)
    // One more varying (a vertex colour) is 17 > 16: the whole WebGPU frame is dropped.
    const plus = struct.replace('};', '  @location(15) vColor : vec4<f32>,\n};')
    expect(wgslInterStageCount(plus + reads).total).toBe(17)
  })

  it('settles a program once when Babylon sees its parallel link complete (a sync uniform-block query)', () => {
    const calls: string[] = []
    const gl = {
      ACTIVE_UNIFORM_BLOCKS: 0x8a36,
      UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
      getProgramParameter: (_p: unknown, k: number) => (calls.push(`p${k.toString(16)}`), 2),
      getActiveUniformBlockParameter: (_p: unknown, i: number, k: number) => (calls.push(`b${i}:${k.toString(16)}`), 64),
    } as unknown as WebGL2RenderingContext
    expect(settleProgram(gl, {} as WebGLProgram)).toBe(128)
    expect(calls).toEqual(['p8a36', 'b0:8a40', 'b1:8a40'])
    // Installed on ThinEngine's readiness check (idempotent); a NullEngine never reaches it.
    installLinkSettle()
    installLinkSettle()
  })
})

describe('installEffectCacheFix (LEAK-2) on WebGPU (W9F final gate)', () => {
  it('drops the processing closures on WebGL only: a WebGPU Effect keeps them (dropping them drew a black frame)', async () => {
    installEffectCacheFix()
    const run = async (webgpu: boolean) => {
      const engine = new NullEngine()
      if (webgpu) Object.defineProperty(engine, 'isWebGPU', { get: () => true, configurable: true })
      const closure = (_: string, code: string) => code
      const effect = engine.createEffect({ vertexSource: 'void main(){gl_Position=vec4(0.);}', fragmentSource: 'void main(){gl_FragColor=vec4(1.);}' }, {
        attributes: [], uniformsNames: [], uniformBuffersNames: [], samplers: [], defines: webgpu ? '#define WEBGPU_TEST' : '', fallbacks: null,
        onCompiled: null, onError: null, indexParameters: {}, processCodeAfterIncludes: closure, processFinalCode: closure,
      }, engine)
      for (let i = 0; i < 20 && !(effect as unknown as { _vertexSourceCode: string })._vertexSourceCode; i++) await new Promise(r => setTimeout(r, 0))
      const e = effect as unknown as { _processCodeAfterIncludes?: unknown; _processFinalCode?: unknown }
      const kept = { processed: !!(effect as unknown as { _vertexSourceCode: string })._vertexSourceCode, after: !!e._processCodeAfterIncludes, final: !!e._processFinalCode }
      engine.dispose()
      return kept
    }
    expect(await run(false)).toEqual({ processed: true, after: false, final: false })
    expect(await run(true)).toEqual({ processed: true, after: true, final: true })
  })
})
