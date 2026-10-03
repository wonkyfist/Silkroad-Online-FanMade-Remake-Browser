/**
 * BT-P (docs/BATCHING.md §3.2–§3.5, §4.5, §6.2; docs/WAVE_PLAN6.md §6.1, D10, D13, D30): the surface plugin's table mode
 * (SRO_TABLE, a region batch's group material) and the foliage plugin's per-vertex tree root (SRO_FOL_PIVOT) and minimum
 * breeze (SRO_FOL_BREEZE).
 *
 * - Off = HEAD: with the three defines off the injected code equals HEAD's byte for byte (golden/head-plugins.ts), in
 *   both languages; the key sets are unchanged (WGSL and GLSL ship the same points).
 * - The code only names what Babylon 9.28's PBR shaders have; the six derivatives sit at the top of main (uniform
 *   control flow); every statement is closed (the prototype's black WebGPU frame was a regex that dropped a `;`).
 * - The contract with BT-A / BT-M: the UV2 packing round-trips inside its margins, the cut-off rescale in TS equals the
 *   shader's test, the table layout.
 * - On a NullEngine: the defines (MAINUV1 / MAINUV2 without a texture, SRO_BAKED, puddles), readiness on the table's
 *   textures, exactly four object samplers and no 2D map (F8), no varying beyond today's heaviest object material, no
 *   uniform or sampler declared twice with the foliage and fog plugins; Babylon's WGSL processor binds the arrays.
 * - PbrSurfaces.addSlotEmissive; the foliage pivot attribute, the breeze and PbrFoliage.attach.
 */
import {
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  ShaderLanguage,
  ShaderStore,
  SphericalPolynomial,
  Vector3,
  Vector4,
  VertexBuffer,
  type Material,
  type Mesh,
  type UniformBuffer,
} from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/Shaders/pbr.vertex.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.vertex.js'
import { WebGPUShaderProcessingContext } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js'
import { WebGPUShaderProcessorWGSL } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.js'
import { PreProcess } from '@babylonjs/core/Engines/Processors/shaderProcessor.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import {
  FOLIAGE_MIN_BREEZE,
  FOLIAGE_PIVOT_KIND,
  FoliageShared,
  PbrFoliage,
  SroFoliagePlugin,
  foliageBend,
  foliageCode,
  foliagePluginOf,
  foliageStrength,
} from '../src/pbr/foliage-plugin.ts'
import {
  EMISSIVE_AMBIENT,
  PbrSurfaces,
  SURFACE_TABLE_SAMPLERS,
  SroSurfacePlugin,
  SurfaceShared,
  TABLE_FLAG,
  TABLE_LIGHTMAP_SIZE,
  TABLE_MAX_ID,
  TABLE_TEXEL,
  TABLE_TEXELS_PER_SLOT,
  packTableUv2,
  surfaceFragmentCode,
  surfacePluginOf,
  tableTestAlpha,
  unpackTableUv2,
  type SurfaceTable,
} from '../src/pbr/surface-plugin.ts'
import { wgslInterStageCount } from '../src/render/gpu-guards.ts'
import type { SkyState } from '../src/sky/types.ts'
import * as head from './golden/head-plugins.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

// ---- helpers --------------------------------------------------------------------------------------------------------

/**
 * Evaluates only `#ifdef X` / `#ifndef X` / `#else` / `#endif` of the given defines, as undefined; every other line and
 * directive stays as it is.
 */
function stripDefines(code: string, names: readonly string[]): string {
  const out: string[] = []
  const stack: Array<{ own: boolean; parent: boolean; branch: boolean }> = []
  let keep = true
  for (const line of code.split('\n')) {
    const own = /^#(ifdef|ifndef)\s+(\w+)\s*$/.exec(line)
    if (own && names.includes(own[2]!)) {
      const branch = own[1] === 'ifndef'
      stack.push({ own: true, parent: keep, branch })
      keep = keep && branch
      continue
    }
    if (/^#if/.test(line)) {
      stack.push({ own: false, parent: keep, branch: true })
      if (keep) out.push(line)
      continue
    }
    const top = stack[stack.length - 1]
    if (/^#else\b/.test(line) && top?.own) {
      top.branch = !top.branch
      keep = top.parent && top.branch
      continue
    }
    if (/^#endif\b/.test(line)) {
      stack.pop()
      if (top?.own) {
        keep = top.parent
        continue
      }
    }
    if (keep) out.push(line)
  }
  expect(stack).toEqual([])
  return out.join('\n')
}

function stripAll(code: Readonly<Record<string, string>>, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(code).map(([k, v]) => [k, stripDefines(v, names)]))
}

/** A PBR shader stage of one language with every include appended (the texts the injection points live in). */
function pbrSources(lang: 'wgsl' | 'glsl', stage: 'vertex' | 'fragment'): string {
  const key = stage === 'vertex' ? 'pbrVertexShader' : 'pbrPixelShader'
  const main = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL[key] : ShaderStore.ShadersStore[key]
  const includes = lang === 'wgsl' ? ShaderStore.IncludesShadersStoreWGSL : ShaderStore.IncludesShadersStore
  expect(main, `pbr ${stage} (${lang})`).toBeTruthy()
  return [main, ...Object.values(includes)].join('\n')
}

/** The lines a define adds (present with it on, gone with it off). */
function linesOf(code: string, names: readonly string[]): string[] {
  const off = new Set(stripDefines(code, names).split('\n'))
  return code.split('\n').filter(l => !off.has(l))
}

const TABLE_DEFINES = ['SRO_TABLE']
const FOLIAGE_DEFINES = ['SRO_FOL_PIVOT', 'SRO_FOL_BREEZE']

interface Rig {
  engine: NullEngine
  scene: Scene
  tex: RawTexture
}

/** A PBR-preset-shaped NullEngine scene (light 0 with a CSM stand-in, an environment cube), as material-budgets'. */
function rig(engine: NullEngine = new NullEngine()): Rig {
  engine.getCaps().textureLOD = true
  engine.getCaps().standardDerivatives = true
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const sun = new DirectionalLight('celestial', new Vector3(-1, -1, 0), scene)
  const csm = {
    id: 'csm',
    getShadowMap: () => ({ renderList: scene.meshes }),
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
  const tex = readyTexture(scene)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return { engine, scene, tex }
}

function readyTexture(scene: Scene): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  t.getInternalTexture()!.isReady = true
  t.isReady = () => true
  return t
}

/** A box with the batch's vertex data: uv, packed uv2 and (trees) the pivot. */
function batchMesh(scene: Scene, mat: Material, opts: { uv2?: boolean; pivot?: boolean } = {}): Mesh {
  const mesh = MeshBuilder.CreateBox('batch', { size: 1 }, scene)
  const n = mesh.getTotalVertices()
  if (opts.uv2 !== false) mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(n * 2).fill(0.5), false, 2)
  if (opts.pivot) mesh.setVerticesData(FOLIAGE_PIVOT_KIND, new Float32Array(n * 3), false, 3)
  mesh.receiveShadows = true
  mesh.material = mat
  return mesh
}

const definesOf = (mesh: Mesh) => mesh.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>

async function ready(mesh: Mesh, tries = 60): Promise<boolean> {
  const mat = mesh.material!
  for (let i = 0; i < tries; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

function tableOf(r: Rig): SurfaceTable {
  return { albedo: readyTexture(r.scene), nrao: readyTexture(r.scene), lightmap: readyTexture(r.scene), table: readyTexture(r.scene) }
}

/** The preprocessed GLSL (WebGL2) of the mesh's compiled effect. */
function glslOf(r: Rig, mesh: Mesh): { frag: string; vert: string } {
  const effect = mesh.subMeshes[0]!.effect as unknown as { defines: string; _fragmentSourceCode: string; _vertexSourceCode: string }
  const defines = effect.defines.split('\n').filter(l => l.startsWith('#define'))
  const pre = (code: string, isFragment: boolean): string => {
    let out = ''
    PreProcess(code, { defines, isFragment, version: '300', platformName: 'WEBGL2', processor: { shaderLanguage: 0 } } as never, (c: string) => {
      out = c
    }, r.engine)
    return out
  }
  return { frag: pre(effect._fragmentSourceCode, true), vert: pre(effect._vertexSourceCode, false) }
}

const samplersOf = (glsl: string) => [...new Set([...glsl.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?sampler\w+\s+(\w+)/g)].map(m => m[1]!))]
const varyingsOf = (glsl: string) => [...new Set([...glsl.matchAll(/(?:^|;)\s*(?:flat\s+)?(?:varying|out)\s+(?:(?:highp|mediump|lowp)\s+)?(?:float|vec[234]|mat[234]|int|ivec[234]|uint|uvec[234])\s+(\w+)\s*;/gm)].map(m => m[1]!))]
  .filter(n => n !== 'glFragColor')

/** The object maps a PBR material binds today (a table material binds none of them, F8). */
const OBJECT_MAPS = ['albedoSampler', 'bumpSampler', 'lightmapSampler', 'reflectivitySampler', 'opacitySampler', 'ambientSampler', 'emissiveSampler', 'microSurfaceSampler']

// ---- the code ---------------------------------------------------------------------------------------------------------

describe('SRO_TABLE / SRO_FOL_PIVOT / SRO_FOL_BREEZE code', () => {
  it('off = HEAD, byte for byte, in both languages (batching off draws today\'s shaders)', () => {
    // RAIN-P (wave 12): the rain film and rings on flat floors sit behind their own define, SRO_RAIN: off = HEAD too.
    expect(stripAll(surfaceFragmentCode('wgsl'), [...TABLE_DEFINES, 'SRO_RAIN'])).toEqual(head.HEAD_SURFACE_WGSL)
    expect(stripAll(surfaceFragmentCode('glsl'), [...TABLE_DEFINES, 'SRO_RAIN'])).toEqual(head.HEAD_SURFACE_GLSL)
    expect(stripAll(foliageCode('vertex', 'wgsl'), FOLIAGE_DEFINES)).toEqual(head.HEAD_FOLIAGE_VERTEX_WGSL)
    expect(stripAll(foliageCode('vertex', 'glsl'), FOLIAGE_DEFINES)).toEqual(head.HEAD_FOLIAGE_VERTEX_GLSL)
    expect(stripAll(foliageCode('fragment', 'wgsl'), FOLIAGE_DEFINES)).toEqual(head.HEAD_FOLIAGE_FRAGMENT_WGSL)
    expect(stripAll(foliageCode('fragment', 'glsl'), FOLIAGE_DEFINES)).toEqual(head.HEAD_FOLIAGE_FRAGMENT_GLSL)
    // The same injection points as HEAD, the same in both languages.
    expect(Object.keys(surfaceFragmentCode('wgsl')).sort()).toEqual(Object.keys(head.HEAD_SURFACE_WGSL).sort())
    expect(Object.keys(surfaceFragmentCode('glsl')).sort()).toEqual(Object.keys(surfaceFragmentCode('wgsl')).sort())
    // And the new code really is there.
    expect(surfaceFragmentCode('wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('sroTexel(')
    expect(surfaceFragmentCode('wgsl').CUSTOM_FRAGMENT_DEFINITIONS).toContain('textureLoad(sroTable')
    expect(foliageCode('vertex', 'wgsl').CUSTOM_VERTEX_UPDATE_WORLDPOS).toContain(`vertexInputs.${FOLIAGE_PIVOT_KIND}`)
  })

  it('names only what Babylon 9.28\'s PBR shaders have, in both languages', () => {
    const frag = ['vMainUV1', 'vMainUV2', 'vPositionW', 'vAlbedoColor', 'ALPHATESTVALUE', 'surfaceAlbedo', 'alpha', 'normalW', 'geometricNormalW',
      'metallicRoughness', 'finalDiffuse', 'finalAmbient', 'finalIrradiance', 'finalSpecularScaled', 'finalSheenScaled', 'finalRadianceScaled',
      'finalSheenRadianceScaled', 'sheenOut', 'finalEmissive', 'NdotVUnclamped', 'viewDirectionW', 'vLightingIntensity',
      'environmentRadianceOcclusion', 'environmentHorizonOcclusion', 'CUSTOM_FRAGMENT_UPDATE_ALBEDO']
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = pbrSources(lang, 'fragment')
      for (const n of frag) expect(src.includes(n), `${lang} ${n}`).toBe(true)
      const table = Object.values(surfaceFragmentCode(lang)).flatMap(c => linesOf(c, TABLE_DEFINES)).join('\n')
      for (const n of frag.filter(n => n !== 'CUSTOM_FRAGMENT_UPDATE_ALBEDO')) expect(table.includes(n), `${lang}: the table code uses ${n}`).toBe(true)
      expect(src.includes(lang === 'wgsl' ? 'fn toLinearSpaceVec3(' : 'vec3 toLinearSpace(vec3')).toBe(true)
      const vsrc = pbrSources(lang, 'vertex')
      for (const n of ['finalWorld', 'worldPos', lang === 'wgsl' ? 'vertexInputs' : 'attribute']) expect(vsrc.includes(n), `${lang} vertex ${n}`).toBe(true)
    }
    // The albedo point is inside Babylon's albedo function, whose colour parameter is vAlbedoColor.
    expect(ShaderStore.IncludesShadersStoreWGSL.pbrBlockAlbedoOpacity).toMatch(/fn albedoOpacityBlock\(\s*vAlbedoColor: vec4f/)
    expect(ShaderStore.IncludesShadersStore.pbrBlockAlbedoOpacity).toMatch(/albedoOpacityBlock\(\s*in vec4 vAlbedoColor/)
  })

  it('takes its derivatives at the top of main, before any branch (uniform control flow on WebGPU)', () => {
    const wgsl = surfaceFragmentCode('wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    expect(wgsl.startsWith('#ifdef SRO_SURFACE\n#ifdef SRO_TABLE\n{\n')).toBe(true)
    const block = wgsl.slice(0, wgsl.indexOf('\n}\n#endif\n'))
    const lines = block.split('\n')
    const derivs = lines.flatMap((l, i) => (/\bdpd[xy]\(/.test(l) ? [i] : []))
    expect(derivs).toHaveLength(6)
    const firstIf = lines.findIndex(l => /^\s*if\s*\(/.test(l))
    expect(firstIf).toBeGreaterThan(Math.max(...derivs))
    for (const i of derivs) expect(lines[i], 'one level deep: the block\'s own braces only').toMatch(/^ {2}\S/)
    // The derivatives exist only in that block, and no implicit-derivative tap anywhere (explicit gradients / LOD).
    for (const [point, code] of Object.entries(surfaceFragmentCode('wgsl'))) {
      const rest = point === 'CUSTOM_FRAGMENT_MAIN_BEGIN' ? code.replace(block, '') : code
      expect(rest, point).not.toMatch(/\b(dpd[xy]\w*|fwidth\w*)\s*\(/)
      expect(code, point).not.toMatch(/\btextureSample(Bias|Compare)?\s*\(/)
    }
    const glsl = surfaceFragmentCode('glsl').CUSTOM_FRAGMENT_MAIN_BEGIN!
    expect(glsl.startsWith('#ifdef SRO_SURFACE\n#ifdef SRO_TABLE\n{\n')).toBe(true)
    expect(glsl.match(/\bdFd[xy]\(/g)).toHaveLength(6)
  })

  it('closes every statement (a dropped `;` blacked out every WebGPU frame in the prototype) and keeps each language to itself', () => {
    const added = [
      ...(['wgsl', 'glsl'] as const).flatMap(lang => Object.values(surfaceFragmentCode(lang)).map(c => ({ lang, lines: linesOf(c, TABLE_DEFINES) }))),
      ...(['wgsl', 'glsl'] as const).flatMap(lang => (['vertex', 'fragment'] as const).map(st => ({ lang, lines: Object.values(foliageCode(st, lang)).flatMap(c => linesOf(c, FOLIAGE_DEFINES)) }))),
    ]
    let n = 0
    for (const { lang, lines } of added) {
      for (const l of lines) {
        if (!l.trim() || l.startsWith('#')) continue
        n++
        expect(l, `${lang}: a closed statement`).toMatch(/[;{}]$/)
        if (lang === 'wgsl') {
          expect(l).not.toMatch(/\b(float|vec[234]|ivec[234]|uint|texture2D|textureLod|textureGrad|texelFetch|dFdx|dFdy|inversesqrt)\s*[(\s]/)
          expect(l).not.toMatch(/\?[^:]*:/)
          expect(l).not.toMatch(/\.\s*[xyzwrgba]{2,4}\s*[-+*/]?=[^=]/)
        } else {
          expect(l).not.toMatch(/\b(fn|let|var)\s|vec[234]f\(|mat3x3f|var<private>|fragmentInputs|vertexInputs|uniforms\.|textureSample\w*\(|textureLoad\(|dpd[xy]\(|select\(/)
        }
      }
    }
    expect(n).toBeGreaterThan(80)
    for (const lang of ['wgsl', 'glsl'] as const) {
      for (const code of Object.values(surfaceFragmentCode(lang))) {
        expect((code.match(/^#if/gm) ?? []).length).toBe((code.match(/^#endif/gm) ?? []).length)
        expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length)
        expect((code.match(/\(/g) ?? []).length).toBe((code.match(/\)/g) ?? []).length)
      }
    }
  })
})

// ---- the contract with BT-A (the table, the atlases) and BT-M (the merged vertex) ------------------------------------

describe('the table contract', () => {
  it('packs (layer, slot) into the integer part of UV2 and gets the lightmap UV back inside its margin, in float32', () => {
    const f = Math.fround
    for (const id of [0, 1, 2, 17, 183, 255, 1024, TABLE_MAX_ID]) {
      for (const u of [0.015, 0.03, 0.5, 0.97, 0.985]) {
        const [u2, v2] = packTableUv2(u, 1 - u, id, TABLE_MAX_ID - id)
        const back = unpackTableUv2(f(u2), f(v2))
        expect([back.layer, back.slot]).toEqual([id, TABLE_MAX_ID - id])
        // ≤ 0.25 texel of a 256² layer (BATCHING §3.3).
        expect(Math.abs(back.u - u)).toBeLessThanOrEqual(0.25 / TABLE_LIGHTMAP_SIZE)
        expect(Math.abs(back.v - (1 - u))).toBeLessThanOrEqual(0.25 / TABLE_LIGHTMAP_SIZE)
      }
    }
  })

  it('the cut-off rescale keeps a texel exactly when its alpha reaches the slot\'s own cut-off (TS = shader)', () => {
    for (const test of [0.5, 0.4]) {
      for (const cut of [0.1, 0.3, 0.5, 0.75]) {
        for (let a = 0; a <= 1.0001; a += 1 / 64) expect(tableTestAlpha(a, cut, test) >= test - 1e-9, `a ${a} cut ${cut}`).toBe(a >= cut - 1e-9)
      }
    }
    for (const lang of ['wgsl', 'glsl'] as const) {
      expect(surfaceFragmentCode(lang).CUSTOM_FRAGMENT_UPDATE_ALBEDO).toMatch(/alpha = vAlbedoColor\.a \* sroTAlb\.a \* \(ALPHATESTVALUE \/ max\(sroTMisc\.z, 0\.001\)\);/)
    }
  })

  it('reads the layout BT-A writes: six texels per slot, one slot per row, the NRAO planes as flags', () => {
    expect(TABLE_TEXELS_PER_SLOT).toBe(6)
    expect(new Set(Object.values(TABLE_TEXEL))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    expect(Object.values(TABLE_FLAG).sort()).toEqual([1, 2, 4])
    for (const lang of ['wgsl', 'glsl'] as const) {
      const main = surfaceFragmentCode(lang).CUSTOM_FRAGMENT_MAIN_BEGIN!
      for (const k of Object.values(TABLE_TEXEL)) expect(main).toContain(`sroTexel(${k}, sroSlot)`)
      expect(surfaceFragmentCode(lang).CUSTOM_FRAGMENT_DEFINITIONS).toMatch(lang === 'wgsl' ? /textureLoad\(sroTable, vec2i\(k, slot\), 0\)/ : /texelFetch\(sroTable, ivec2\(k, slot\), 0\)/)
    }
    expect(SURFACE_TABLE_SAMPLERS).toEqual(['sroAlbArr', 'sroNraoArr', 'sroLmArr', 'sroTable'])
  })
})

// ---- the plugin on a NullEngine ---------------------------------------------------------------------------------------

function tableMaterial(r: Rig, opts: { selfLit?: boolean; cutout?: boolean; table?: SurfaceTable | null } = {}): { mat: PBRMaterial; plugin: SroSurfacePlugin; shared: SurfaceShared } {
  const mat = new PBRMaterial('batch:group', r.scene)
  mat.backFaceCulling = true
  if (opts.cutout) mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  const shared = new SurfaceShared()
  const table = opts.table === undefined ? tableOf(r) : opts.table ?? undefined
  const plugin = new SroSurfacePlugin(mat, shared, { cls: 'stone', selfLit: opts.selfLit, table })
  return { mat, plugin, shared }
}

describe('SroSurfacePlugin in table mode', () => {
  it('sets the UV varyings and the baked path itself, binds no 2D map, and waits for the table\'s textures', async () => {
    const r = rig()
    const table: SurfaceTable = { albedo: null, nrao: readyTexture(r.scene), lightmap: readyTexture(r.scene), table: readyTexture(r.scene) }
    const { mat, plugin, shared } = tableMaterial(r, { table })
    expect(plugin.baked).toBe(true)
    const mesh = batchMesh(r.scene, mat)
    expect(await ready(mesh, 8), 'not ready without the albedo atlas').toBe(false)
    let d = definesOf(mesh)
    expect([d.SRO_TABLE, d.MAINUV1, d.MAINUV2, d.UV1, d.UV2, d.SRO_BAKED]).toEqual([true, true, true, true, true, true])
    expect([d.ALBEDO, d.BUMP, d.LIGHTMAP, d.REFLECTIVITY, d.OPACITY]).toEqual([false, false, false, false, false])
    expect(d.LIGHTMAPEXCLUDED).not.toBe(true)
    table.albedo = readyTexture(r.scene)
    expect(await ready(mesh)).toBe(true)

    // Puddles follow the weather only (the slot's weight is in its row), whatever the group plugin's own surf.w.
    plugin.surf.w = 0
    shared.wet = true
    shared.puddles = true
    shared.dirtyAll()
    expect(await ready(mesh)).toBe(true)
    d = definesOf(mesh)
    expect([d.SRO_WET, d.SRO_PUDDLES]).toEqual([true, true])

    // A mesh without the packed UV2 draws with HEAD's code; so does the plugin once the table goes.
    const plain = batchMesh(r.scene, mat, { uv2: false })
    expect(await ready(plain)).toBe(true)
    expect(definesOf(plain).SRO_TABLE).toBe(false)
    plugin.setTable(null)
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_TABLE).toBe(false)
  })

  it('HEAD\'s plugin (no table) never turns SRO_TABLE or the UV varyings on', async () => {
    const r = rig()
    const mat = new PBRMaterial('wall', r.scene)
    new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'stone' })
    const mesh = batchMesh(r.scene, mat)
    expect(await ready(mesh)).toBe(true)
    const d = definesOf(mesh)
    expect([d.SRO_TABLE, d.MAINUV1, d.MAINUV2, d.SRO_BAKED]).toEqual([false, false, false, false])
  })

  it('setTable before the first draw switches a new group material (BT-A\'s bindMaterial) with the samplers registered', async () => {
    const r = rig()
    const { mat, plugin } = tableMaterial(r, { table: null })
    expect(plugin.table).toBeNull()
    const table = tableOf(r)
    plugin.setTable(table)
    expect(plugin.table).toBe(table)
    expect(plugin.baked).toBe(true)
    const mesh = batchMesh(r.scene, mat)
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_TABLE).toBe(true)
    const samplers = (mat.pluginManager as unknown as { _samplerList: string[] })._samplerList
    for (const s of SURFACE_TABLE_SAMPLERS) expect(samplers).toContain(s)
  })

  it('binds the four table textures (read at bind time: BT-A may swap a grown array in place)', async () => {
    const r = rig()
    const table = tableOf(r)
    const { mat } = tableMaterial(r, { table })
    const mesh = batchMesh(r.scene, mat)
    expect(await ready(mesh)).toBe(true)
    const bound = new Map<string, unknown>()
    const ubo = { setTexture: (name: string, tex: unknown) => bound.set(name, tex), updateVector4: () => {}, updateFloat4: () => {} } as unknown as UniformBuffer
    const grown = readyTexture(r.scene)
    table.albedo = grown
    surfacePluginOf(mat)!.bindForSubMesh(ubo, r.scene, r.engine, mesh.subMeshes[0]!)
    expect(bound.get('sroAlbArr')).toBe(grown)
    expect(bound.get('sroNraoArr')).toBe(table.nrao)
    expect(bound.get('sroLmArr')).toBe(table.lightmap)
    expect(bound.get('sroTable')).toBe(table.table)
  })

  it('WebGL2: exactly four object samplers and no 2D map (F8); no varying beyond today\'s heaviest object material', async () => {
    const r = rig()
    const { mat, shared } = tableMaterial(r, { selfLit: true, cutout: true })
    shared.wet = true
    shared.puddles = true
    const mesh = batchMesh(r.scene, mat)
    expect(await ready(mesh)).toBe(true)
    const table = glslOf(r, mesh)
    const samplers = samplersOf(table.frag)
    for (const s of SURFACE_TABLE_SAMPLERS) expect(samplers).toContain(s)
    for (const s of OBJECT_MAPS) expect(samplers).not.toContain(s)
    const objectUnits = samplers.filter(s => SURFACE_TABLE_SAMPLERS.includes(s) || OBJECT_MAPS.includes(s))
    expect(objectUnits).toHaveLength(4)

    // Today's heaviest object material: albedo, bump, ORM, opacity and the lightmap on UV2 (5 object units).
    const heavy = new PBRMaterial('heavy', r.scene)
    heavy.albedoTexture = readyTexture(r.scene)
    heavy.bumpTexture = readyTexture(r.scene)
    heavy.metallicTexture = readyTexture(r.scene)
    heavy.useRoughnessFromMetallicTextureGreen = true
    heavy.useAmbientOcclusionFromMetallicTextureRed = true
    heavy.opacityTexture = readyTexture(r.scene)
    heavy.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    const lm = readyTexture(r.scene)
    lm.coordinatesIndex = 1
    heavy.lightmapTexture = lm
    heavy.useLightmapAsShadowmap = true
    const hs = new SurfaceShared()
    hs.wet = true
    hs.puddles = true
    new SroSurfacePlugin(heavy, hs, { cls: 'stone', baked: true })
    const hmesh = batchMesh(r.scene, heavy)
    expect(await ready(hmesh)).toBe(true)
    const today = glslOf(r, hmesh)
    const heavyObject = samplersOf(today.frag).filter(s => OBJECT_MAPS.includes(s))
    expect(heavyObject.length).toBeGreaterThanOrEqual(5)
    expect(objectUnits.length).toBeLessThan(heavyObject.length)
    const tv = varyingsOf(table.vert)
    const hv = new Set(varyingsOf(today.vert))
    expect(tv.filter(v => !hv.has(v)), 'varyings the heaviest object material does not have').toEqual([])
    expect(tv).toEqual(expect.arrayContaining(['vMainUV1', 'vMainUV2', 'vPositionW', 'vNormalW']))
    // No front_facing: a table group draws single-sided (two-sided pieces are emitted twice).
    expect(table.frag).not.toMatch(/\bgl_FrontFacing\b/)
  })

  it('with the foliage pivot and the fog, every UBO member and sampler is declared once, in GLSL and WGSL', async () => {
    const r = rig()
    const { mat } = tableMaterial(r)
    const fol = new FoliageShared()
    Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
    new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
    attachFogPlugin(mat, new HeightFog(r.scene))
    const mesh = batchMesh(r.scene, mat, { pivot: true })
    expect(await ready(mesh)).toBe(true)
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
      const members = pm._uboDeclaration.split('\n').map(l => l.trim()).filter(Boolean).map(l => /^uniform\s+(\w+)\s*:/.exec(l)?.[1] ?? /^\w+\s+(\w+)/.exec(l)?.[1] ?? l)
      expect(dupes(members), `members ${lang}`).toEqual([])
      expect(dupes(pm._samplerList), `samplers ${lang}`).toEqual([])
      for (const s of SURFACE_TABLE_SAMPLERS) expect(pm._samplerList.filter(x => x === s)).toHaveLength(1)
    }
  })
})

// ---- the assembled WGSL (Babylon's WGSL processor on a NullEngine, as abuse-w9f-uniformity) -------------------------

/** Babylon's WGSL processor and processing context on a NullEngine (no GPU): the WGSL a WebGPU device would compile. */
function wgslEngine(): NullEngine {
  const engine = new NullEngine()
  const e = engine as unknown as Record<string, unknown>
  e._isWebGPU = true
  e._webGLVersion = 2
  Object.defineProperty(engine, 'supportsUniformBuffers', { get: () => true })
  Object.defineProperty(engine, 'shaderPlatformName', { get: () => 'WEBGPU' })
  Object.defineProperty(engine, 'isNDCHalfZRange', { get: () => true })
  const caps = engine.getCaps()
  caps.textureLOD = true
  caps.texelFetch = true
  caps.textureHalfFloat = true
  caps.textureHalfFloatLinearFiltering = true
  const wgsl = new WebGPUShaderProcessorWGSL()
  const orig = engine._getShaderProcessor.bind(engine)
  e._getShaderProcessor = (lang: ShaderLanguage) => (lang === ShaderLanguage.WGSL ? wgsl : orig(lang))
  e._getShaderProcessingContext = (lang: ShaderLanguage, pure: boolean) => new WebGPUShaderProcessingContext(lang, pure)
  return engine
}

describe('the assembled WGSL of a merged tree group (Babylon\'s WGSL processor)', () => {
  it('binds the three arrays and the table, fetches the table, reads the pivot attribute, and binds no object map', async () => {
    const r = rig(wgslEngine())
    const { mat } = tableMaterial(r, { selfLit: true, cutout: true })
    const fol = new FoliageShared()
    Object.assign(fol, { active: true, wind: true, translucency: true, u: { wxA: new Vector4(0, 0, 0, 1), wxB: new Vector4(1, 0, 0.5, 1) } })
    new SroFoliagePlugin(mat, fol, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
    const mesh = batchMesh(r.scene, mat, { pivot: true })
    type Sources = { _fragmentSourceCode: string; _vertexSourceCode: string }
    const sources = () => mesh.subMeshes[0]!.effect as unknown as Sources | null
    for (let i = 0; i < 200 && !sources()?._fragmentSourceCode; i++) {
      r.scene.incrementRenderId()
      mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)
      await new Promise(res => setTimeout(res, 3))
    }
    const effect = sources()
    const frag = effect!._fragmentSourceCode
    const vert = effect!._vertexSourceCode
    expect(frag.length).toBeGreaterThan(10_000)
    for (const n of ['sroAlbArr', 'sroNraoArr', 'sroLmArr']) expect(frag).toMatch(new RegExp(`@binding\\(\\d+\\)\\s*var\\s+${n}\\s*:\\s*texture_2d_array<f32>`))
    expect(frag).toMatch(/@binding\(\d+\)\s*var\s+sroTable\s*:\s*texture_2d<f32>/)
    expect(frag).toContain('textureLoad(sroTable')
    expect(frag).toContain('textureSampleGrad(sroAlbArr')
    expect(frag).toContain('fragmentInputs.vMainUV2')
    for (const s of OBJECT_MAPS) expect(frag).not.toMatch(new RegExp(`var\\s+${s}\\s*:`))
    expect(vert).toMatch(/sroPivot\s*:\s*vec3<?f/)
    expect(vert).toContain('vertexInputs.sroPivot')
    expect(vert).toContain('max(clamp(uniforms.wxB.z, 0.0, 1.0), uniforms.sroFol.y)')
    // No new inter-stage variable: the lightmapped object's two UV sets and its usual ones, ≤ 15 + front_facing.
    const count = wgslInterStageCount(frag)
    expect(count.total).toBeLessThanOrEqual(16)
  }, 60_000)
})

// ---- the lamp group's retail emissive ---------------------------------------------------------------------------------

describe('PbrSurfaces.addSlotEmissive', () => {
  it('writes base × EMISSIVE_AMBIENT × the ambient into the slot every PBR frame, until removed; black is ignored', () => {
    const r = rig()
    const part = new PbrSurfaces(r.scene)
    const sky = { keyLight: { dir: new Vector3(0, 1, 0) }, night: 0, cloudShadow: null, cloudNoise: null, ambient: { sky: [0.5, 0.25, 1], horizon: [0, 0, 0], ground: [0, 0, 0] } } as unknown as SkyState
    const writes: number[][] = []
    const off = part.addSlotEmissive(new Color3(0.2, 0.4, 0.6), (a, b, c) => writes.push([a, b, c]))
    expect(part.addSlotEmissive(Color3.Black(), () => writes.push([-1]))).toBeTypeOf('function')
    expect(part.slotEmissiveCount).toBe(1)
    part.update(null, sky) // Classic: nothing
    expect(writes).toEqual([])
    part.setMode('pbr')
    part.update(null, sky)
    const k = EMISSIVE_AMBIENT * r.scene.environmentIntensity
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]).toBeCloseTo(0.2 * 0.5 * k, 9)
    expect(writes[0]![1]).toBeCloseTo(0.4 * 0.25 * k, 9)
    expect(writes[0]![2]).toBeCloseTo(0.6 * 1 * k, 9)
    off()
    part.update(null, sky)
    expect(writes).toHaveLength(1)
    expect(part.slotEmissiveCount).toBe(0)
    part.dispose()
  })

  it('the lamp group reads the slot\'s texel 5 (a = 1: × the albedo, as SRO_SELFLIT) after HEAD\'s self-lit line', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = surfaceFragmentCode(lang).CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION!
      const headLine = code.indexOf('#ifdef SRO_SELFLIT\nfinalEmissive = finalEmissive * surfaceAlbedo;\n#endif')
      const table = code.indexOf('finalEmissive = sroTEm.rgb')
      expect(headLine).toBeGreaterThan(0)
      expect(table).toBeGreaterThan(headLine)
      expect(code.slice(table, code.indexOf('\n', table))).toMatch(/sroTEm\.a > 0\.5/)
    }
  })
})

// ---- the foliage pivot and the minimum breeze ----------------------------------------------------------------------

describe('SroFoliagePlugin: SRO_FOL_PIVOT and SRO_FOL_BREEZE', () => {
  const WIND = { wxA: new Vector4(0, 0, 0, 3), wxB: new Vector4(0.8, 0.6, 0.5, 3) }

  it('the pivot is on for a mesh with the roots while the vertex code moves it, and its attribute follows', async () => {
    const r = rig()
    const { mat } = tableMaterial(r)
    const shared = new FoliageShared()
    Object.assign(shared, { active: true, wind: true, translucency: true, u: WIND })
    const p = new SroFoliagePlugin(mat, shared, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE, shadowWrapper: false })
    const trees = batchMesh(r.scene, mat, { pivot: true })
    expect(await ready(trees)).toBe(true)
    let d = definesOf(trees)
    expect([d.SRO_FOL_WIND, d.SRO_FOL_FLUTTER, d.SRO_FOL_PIVOT, d.SRO_FOL_BREEZE]).toEqual([true, true, true, true])
    const attrs: string[] = []
    p.getAttributes(attrs, r.scene, trees)
    expect(attrs).toEqual([FOLIAGE_PIVOT_KIND])

    // A mesh without roots (a thin-instanced static tree): the instance origin, no attribute.
    const single = batchMesh(r.scene, mat)
    expect(await ready(single)).toBe(true)
    expect(definesOf(single).SRO_FOL_PIVOT).toBe(false)
    const none: string[] = []
    p.getAttributes(none, r.scene, single)
    expect(none).toEqual([])

    // No wind switch: nothing moves, no pivot, no breeze.
    shared.wind = false
    shared.dirtyAll()
    expect(await ready(trees)).toBe(true)
    d = definesOf(trees)
    expect([d.SRO_FOL_WIND, d.SRO_FOL_PIVOT, d.SRO_FOL_BREEZE]).toEqual([false, false, false])
  })

  it('the breeze is a define only while set, bound in sroFol.y, and never lowers the wind', async () => {
    const r = rig()
    const { mat } = tableMaterial(r)
    const shared = new FoliageShared()
    Object.assign(shared, { active: true, wind: true, u: WIND })
    const p = new SroFoliagePlugin(mat, shared, { leaf: false, kind: 'static' })
    expect(p.breeze).toBe(0)
    const mesh = batchMesh(r.scene, mat, { pivot: true })
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_FOL_BREEZE).toBe(false)
    p.breeze = FOLIAGE_MIN_BREEZE
    expect(await ready(mesh)).toBe(true)
    expect(definesOf(mesh).SRO_FOL_BREEZE).toBe(true)
    const writes: number[][] = []
    const ubo = {
      updateFloat4: (name: string, x: number, y: number, z: number, w: number) => {
        if (name === 'sroFol') writes.push([x, y, z, w])
      },
    } as unknown as UniformBuffer
    p.bindForSubMesh(ubo, r.scene, r.engine, mesh.subMeshes[0]!)
    expect(writes.at(-1)?.[1]).toBe(FOLIAGE_MIN_BREEZE)
    p.breeze = Number.NaN
    expect(p.breeze).toBe(0)

    expect(FOLIAGE_MIN_BREEZE).toBe(0.15) // BATCHING Q3's default, tuned by BT-T at the grove
    expect(foliageStrength(0.4)).toBe(0.4)
    expect(foliageStrength(0, 0)).toBe(0)
    expect(foliageStrength(0, FOLIAGE_MIN_BREEZE)).toBe(FOLIAGE_MIN_BREEZE)
    expect(foliageStrength(0.8, FOLIAGE_MIN_BREEZE)).toBe(0.8)
    expect(foliageStrength(2, FOLIAGE_MIN_BREEZE)).toBe(1)
    // Calm: an 8 m crown sways a gentle ~0.1 m instead of standing still.
    expect(foliageBend(8, foliageStrength(0, FOLIAGE_MIN_BREEZE), 1)).toBeCloseTo(0.1152, 4)
    expect(foliageBend(8, foliageStrength(0), 1)).toBe(0)
  })

  it('the pivot moves through the mesh\'s world matrix like the positions (either space works)', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const code = foliageCode('vertex', lang).CUSTOM_VERTEX_UPDATE_WORLDPOS!
      expect(code).toContain(lang === 'wgsl' ? '(finalWorld * vec4f(vertexInputs.sroPivot, 1.0)).xyz' : '(finalWorld * vec4(sroPivot, 1.0)).xyz')
      const defs = foliageCode('vertex', lang).CUSTOM_VERTEX_DEFINITIONS!
      expect(defs).toContain(lang === 'wgsl' ? 'attribute sroPivot: vec3f;' : 'attribute vec3 sroPivot;')
    }
  })

  it('PbrFoliage.attach puts the plugin on a batch group material (with the surface plugin) and never wraps it for the CSM', () => {
    const r = rig()
    const decorators: unknown[] = []
    const part = new PbrFoliage(r.scene, { addDecorator: fn => (decorators.push(fn), () => {}) }, { mode: 'pbr', quality: { foliage: { wind: true, translucency: true, csmCaster: true }, shadows: {} } as never }, null, { shadowWrapper: true })
    cleanups.push(() => part.dispose())
    const bare = new PBRMaterial('bare', r.scene)
    expect(part.attach(bare, { leaf: true, kind: 'static' })).toBeNull()
    const { mat } = tableMaterial(r)
    const p = part.attach(mat, { leaf: true, kind: 'static', breeze: FOLIAGE_MIN_BREEZE })
    expect(p).not.toBeNull()
    expect(foliagePluginOf(mat)).toBe(p)
    expect(p!.shared).toBe(part.shared)
    expect(p!.breeze).toBe(FOLIAGE_MIN_BREEZE)
    expect(p!.wrappable).toBe(false)
    p!.syncWrapper(true)
    expect(p!.wrapper).toBeNull()
    expect(part.attach(mat, { leaf: false, kind: 'static' })).toBe(p)
  })
})
