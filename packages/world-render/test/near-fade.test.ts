/**
 * The camera-near foliage fade (trees/near-fade.ts; docs/FOREST.md D-F18, §5.5): the same injection point in WGSL and
 * GLSL on the PBR and Standard fragments, no other language's idioms; the Bayer pattern and the ramps; the defines only
 * on foliage (leaves both fades, wood the near one, never a skinned mesh, a cloth group or a plain material); uniform
 * updates with no allocation and no recompile from frame to frame.
 */
import { ArcRotateCamera, FreeCamera, MeshBuilder, NullEngine, PBRMaterial, Scene, ShaderStore, Skeleton, StandardMaterial, Vector3, type Mesh, type UniformBuffer } from '@babylonjs/core'
import '@babylonjs/core/Shaders/pbr.fragment.js'
import '@babylonjs/core/ShadersWGSL/pbr.fragment.js'
import '@babylonjs/core/Shaders/default.fragment.js'
import '@babylonjs/core/ShadersWGSL/default.fragment.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPSULE_FEATHER_M,
  CAPSULE_R_M,
  FoliageShared,
  NEAR_FADE_PLUGIN,
  NEAR_FADE_UNIFORMS,
  NEAR_GONE_M,
  NEAR_START_M,
  SroFoliagePlugin,
  SroNearFadePlugin,
  bayer4,
  installNearFade,
  nearFadeCode,
  nearFadeKeep,
  nearFadeKeeps,
  nearFadeKindOf,
  nearFadeStateOf,
  uninstallNearFade,
} from '../src/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function nullScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

const balanced = (s: string) => (s.match(/#if/g) ?? []).length === (s.match(/#endif/g) ?? []).length
const WGSL_BAD = /\b(float|vec[234]|uvec[234]|ivec[234]|texture2D|dFdx|dFdy|gl_\w+)\s*[(\s]/
const GLSL_BAD = /\b(fn|let)\s|vec[234][fu]\(|var<private>|fragmentInputs|uniforms\./

function sources(kind: 'pbr' | 'default', lang: 'wgsl' | 'glsl'): string {
  const store = lang === 'wgsl' ? ShaderStore.ShadersStoreWGSL : ShaderStore.ShadersStore
  return store[`${kind}PixelShader`]!
}

describe('the near-fade code (D-F18)', () => {
  it('one point, in both languages, a real point of the PBR and Standard fragments of Babylon 9.28', () => {
    const w = nearFadeCode('wgsl'), g = nearFadeCode('glsl')
    expect(Object.keys(w)).toEqual(['CUSTOM_FRAGMENT_MAIN_BEGIN'])
    expect(Object.keys(g)).toEqual(Object.keys(w))
    for (const kind of ['pbr', 'default'] as const) {
      for (const lang of ['wgsl', 'glsl'] as const) expect(sources(kind, lang).includes('#define CUSTOM_FRAGMENT_MAIN_BEGIN'), `${kind} ${lang}`).toBe(true)
    }
  })

  it('guarded, balanced, no idiom of the other language; the uniforms and the capsule are in both', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const s = nearFadeCode(lang).CUSTOM_FRAGMENT_MAIN_BEGIN!
      expect(s.startsWith('#ifdef SRO_NFADE\n')).toBe(true)
      expect(balanced(s)).toBe(true)
      expect(s).toMatch(/#ifdef SRO_NFADE_CAP/)
      expect(s).toMatch(/discard;/)
      for (const u of NEAR_FADE_UNIFORMS) expect(s).toContain(u)
      expect(s).not.toMatch(lang === 'wgsl' ? WGSL_BAD : GLSL_BAD)
    }
    expect(nearFadeCode('wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toMatch(/fragmentInputs\.vPositionW/)
    expect(nearFadeCode('wgsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toMatch(/fragmentInputs\.position\.xy/)
    expect(nearFadeCode('glsl').CUSTOM_FRAGMENT_MAIN_BEGIN).toMatch(/gl_FragCoord\.xy/)
  })

  it('the Bayer pattern is the classic 4 × 4 matrix, a permutation of 0..15', () => {
    const rows = [0, 1, 2, 3].map(y => [0, 1, 2, 3].map(x => bayer4(x, y)))
    expect(rows).toEqual([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]])
    expect(bayer4(5, 6)).toBe(bayer4(1, 2))
  })

  it('the ramps: nothing kept by NEAR_GONE_M, all from NEAR_START_M; the capsule core gone, its edge back; the share kept is k', () => {
    expect(nearFadeKeep(NEAR_GONE_M - 0.5)).toBe(0)
    expect(nearFadeKeep(NEAR_START_M + 0.1)).toBe(1)
    expect(nearFadeKeep((NEAR_GONE_M + NEAR_START_M) / 2)).toBeCloseTo(0.5)
    expect(nearFadeKeep(20, CAPSULE_R_M * 0.5)).toBe(0)
    expect(nearFadeKeep(20, CAPSULE_R_M + CAPSULE_FEATHER_M)).toBe(1)
    expect(nearFadeKeep(20, 0, 0)).toBe(1) // the gate closed
    for (const k of [0, 0.25, 0.5, 0.75, 1]) {
      let kept = 0
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (nearFadeKeeps(k, x, y)) kept++
      expect(kept / 16).toBeCloseTo(k)
    }
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

describe('the near-fade plugin on NullEngine materials (D-F18)', () => {
  it('foliage only: leaves both fades, wood the near one; never skinned, cloth or plain materials; existing ones too', async () => {
    const scene = nullScene()
    const early = new StandardMaterial('early', scene)
    const state = installNearFade(scene)
    expect(nearFadeStateOf(scene)).toBe(state)
    expect(early.pluginManager?.getPlugin(NEAR_FADE_PLUGIN)).toBeInstanceOf(SroNearFadePlugin)
    const shared = new FoliageShared()
    const leaf = new PBRMaterial('leaf', scene)
    new SroFoliagePlugin(leaf, shared, { leaf: true, kind: 'static' })
    const wood = new PBRMaterial('wood', scene)
    new SroFoliagePlugin(wood, shared, { leaf: false, kind: 'static' })
    const cloth = new PBRMaterial('cloth', scene)
    new SroFoliagePlugin(cloth, shared, { leaf: false, kind: 'static', cloth: true })
    const classicLeaf = new StandardMaterial('tree_leaf', scene)
    classicLeaf.metadata = { sroNearFade: 'leaf' }
    const plain = new PBRMaterial('wall', scene)
    expect(nearFadeKindOf(leaf)).toBe('leaf')
    expect(nearFadeKindOf(wood)).toBe('wood')
    expect(nearFadeKindOf(cloth)).toBe(null)
    expect(nearFadeKindOf(classicLeaf)).toBe('leaf')
    expect(nearFadeKindOf(plain)).toBe(null)
    const meshes = [leaf, wood, cloth, classicLeaf, plain, early].map(m => {
      const mesh = MeshBuilder.CreateBox(m.name, { size: 1 }, scene)
      mesh.material = m
      return mesh
    })
    const skinned = MeshBuilder.CreateBox('skinnedLeaf', { size: 1 }, scene)
    const leaf2 = new PBRMaterial('leaf2', scene)
    new SroFoliagePlugin(leaf2, shared, { leaf: true, kind: 'clone' })
    skinned.material = leaf2
    skinned.skeleton = new Skeleton('s', 's', scene)
    for (const m of [...meshes, skinned]) expect(await ready(m)).toBe(true)
    const [mLeaf, mWood, mCloth, mClassic, mPlain, mEarly] = meshes.map(definesOf)
    expect([mLeaf!.SRO_NFADE, mLeaf!.SRO_NFADE_CAP]).toEqual([true, true])
    expect([mWood!.SRO_NFADE, mWood!.SRO_NFADE_CAP]).toEqual([true, false])
    expect(mCloth!.SRO_NFADE).toBe(false)
    expect([mClassic!.SRO_NFADE, mClassic!.SRO_NFADE_CAP]).toEqual([true, true])
    expect(mPlain!.SRO_NFADE).toBe(false)
    expect(mEarly!.SRO_NFADE).toBe(false)
    expect(definesOf(skinned).SRO_NFADE).toBe(false)
    // the effect carries the code
    expect(meshes[0]!.subMeshes[0]!.effect!.defines.split('\n')).toContain('#define SRO_NFADE_CAP')
    uninstallNearFade(scene)
    expect(nearFadeStateOf(scene)).toBe(null)
    expect(await ready(meshes[0]!)).toBe(true)
    expect(definesOf(meshes[0]!).SRO_NFADE).toBe(false)
  })

  it('the decorator tags foliage models: cut-out = leaf, opaque = wood; other models untouched', () => {
    const scene = nullScene()
    const state = installNearFade(scene)
    let deco: ((mat: StandardMaterial, info: { source: string; alpha: 'opaque' | 'mask' | 'blend' }) => void) | null = null
    state.attach({ addDecorator: fn => ((deco = fn as typeof deco), () => (deco = null)) })
    const a = new StandardMaterial('a', scene), b = new StandardMaterial('b', scene), c = new StandardMaterial('c', scene)
    deco!(a, { source: 'res\\nature\\china\\jangan\\tree\\cj_tree01.bsr', alpha: 'mask' })
    deco!(b, { source: 'res\\nature\\china\\jangan\\tree\\cj_tree01.bsr', alpha: 'opaque' })
    deco!(c, { source: 'res\\bldg\\china\\jangan\\wall.bsr', alpha: 'mask' })
    expect([nearFadeKindOf(a), nearFadeKindOf(b), nearFadeKindOf(c)]).toEqual(['leaf', 'wood', null])
    uninstallNearFade(scene)
    expect(deco).toBe(null)
  })

  it('per frame: the camera and the orbit target are uniforms (no allocation, no recompile); the switch compiles once', async () => {
    const scene = nullScene()
    const state = installNearFade(scene)
    const leaf = new PBRMaterial('leaf', scene)
    new SroFoliagePlugin(leaf, new FoliageShared(), { leaf: true, kind: 'static' })
    const mesh = MeshBuilder.CreateBox('leaf', { size: 1 }, scene)
    mesh.material = leaf
    expect(await ready(mesh)).toBe(true)
    const effect = mesh.subMeshes[0]!.effect!
    const cam = new ArcRotateCamera('cam', 0, 1, 9, new Vector3(10, 1.5, 20), scene)
    const a = state.a, b = state.b
    const plugin = leaf.pluginManager!.getPlugin<SroNearFadePlugin>(NEAR_FADE_PLUGIN)!
    const writes: Record<string, number[]> = {}
    const ubo = { updateFloat4: (n: string, x: number, y: number, z: number, w: number) => (writes[n] = [x, y, z, w]) } as unknown as UniformBuffer
    for (let i = 0; i < 60; i++) {
      cam.alpha = i * 0.1
      cam.target.set(10 + i, 1.5, 20)
      cam.computeWorldMatrix()
      state.update(cam)
      expect(state.a).toBe(a)
      expect(state.b).toBe(b)
      plugin.bindForSubMesh(ubo)
      expect(writes['sroNfA']!.slice(0, 3)).toEqual([cam.globalPosition.x, cam.globalPosition.y, cam.globalPosition.z])
      expect(writes['sroNfB']).toEqual([10 + i, 1.5, 20, 1])
      scene.incrementRenderId()
      expect(leaf.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true)
      expect(mesh.subMeshes[0]!.effect).toBe(effect)
    }
    // a free camera: no capsule; no camera: off
    const free = new FreeCamera('free', new Vector3(1, 2, 3), scene)
    state.update(free)
    expect(state.b.w).toBe(0)
    expect(state.a.w).toBe(1)
    state.update(null)
    expect(state.a.w).toBe(0)
    // the camera on its target: no capsule
    cam.radius = 0.1
    cam.lowerRadiusLimit = 0
    cam.computeWorldMatrix()
    state.update(cam)
    expect(state.b.w).toBe(0)
    // the switch: one new effect without the code, then the code again
    state.setEnabled(false)
    expect(await ready(mesh)).toBe(true)
    expect(mesh.subMeshes[0]!.effect!.uniqueId).not.toBe(effect.uniqueId)
    state.setEnabled(true)
    expect(await ready(mesh)).toBe(true)
    expect(mesh.subMeshes[0]!.effect!.defines.split('\n')).toContain('#define SRO_NFADE')
  })
})
