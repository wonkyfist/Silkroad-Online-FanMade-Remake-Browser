/**
 * Wave 9A hotfix: the live switch to the modern graphics (Options → "Modern graphics (preview)", World.setRenderMode).
 *
 * 1. Character materials. WX-C's decorator wets them on the Classic path (WetnessPlugin); the switch adds RND-M's
 *    SroSurfacePlugin (and the height fog) to the same material. Babylon joins every plugin's UBO members into one
 *    uniform block, and both plugins declared the shelter members: on WebGL2 every character, mob and NPC shader
 *    failed ("Duplicate field name in structure") and Babylon skipped the meshes. Each member and sampler must be
 *    declared once, in GLSL and in WGSL, on every path and across every switch.
 * 2. The prepass. A dirty PrePassRenderer re-reads its state at its next draw; when that draw was the weather's
 *    shelter map (a render target with its own camera, so no post-processes) the prepass turned itself off and SSR
 *    bound textures at index -1: a TypeError that stopped the render loop on High and Ultra in the rain. The shelter
 *    map never takes part in the prepass, and RenderPost settles a dirty prepass against its camera first.
 */
import {
  ArcRotateCamera,
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PostProcess,
  PrePassRenderer,
  RenderTargetTexture,
  Scene,
  ShaderLanguage,
  Vector3,
  type Material,
  type Mesh,
} from '@babylonjs/core'
import '@babylonjs/core/Rendering/prePassRendererSceneComponent.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_RENDER_WEATHER, PbrSurfaces, RENDER_PRESETS, WeatherShelter, WorldRender, attachWetness, surfacePluginOf, type GpuInfo, type RenderPreset } from '../src/index.ts'
import { HeightFog, attachFogPlugin } from '../src/pbr/fog-plugin.ts'
import { PREPASS_REPAIRS_MAX, installRenderPost } from '../src/render/post.ts'
import { WETNESS_PLUGIN, renderDeclared } from '../src/weather/wet-plugin.ts'

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
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

/** Prepares the defines and waits for the (NullEngine) effect: the first call compiles, a later one is ready. */
async function ready(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material!
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId() // a new frame: the defines are re-checked
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

/** Builds the material's uniform layout in `lang` and returns what its plugins declared. */
function declared(mat: Material, lang: ShaderLanguage): { members: string[]; samplers: string[] } {
  const m = mat as unknown as { _shaderLanguage: ShaderLanguage; buildUniformLayout(): void }
  const was = m._shaderLanguage
  m._shaderLanguage = lang
  try {
    m.buildUniformLayout()
  } finally {
    m._shaderLanguage = was
  }
  const pm = mat.pluginManager as unknown as { _uboDeclaration: string; _samplerList: string[] }
  return { members: memberNames(pm._uboDeclaration), samplers: [...pm._samplerList] }
}

/** A glTF-like character body material on a mesh, as ModelLibrary instances share it. */
function character(scene: Scene, name = 'chinaman_body'): { mat: PBRMaterial; mesh: Mesh } {
  const mat = new PBRMaterial(name, scene)
  mat.maxSimultaneousLights = 5
  const mesh = MeshBuilder.CreateBox(`${name}:mesh`, { size: 1 }, scene)
  mesh.material = mat
  return { mat, mesh }
}

function surfaces(scene: Scene, preset: RenderPreset = 'medium'): PbrSurfaces {
  const s = new PbrSurfaces(scene)
  s.attach({ mode: 'classic', quality: RENDER_PRESETS[preset], weather: CLEAR_RENDER_WEATHER, materials: null })
  return s
}

describe('a character material across the live switch (wetness, surface, fog)', () => {
  it('declares every UBO member and sampler once in GLSL and WGSL after the switch, and stays ready', async () => {
    const scene = nullScene()
    const { mat, mesh } = character(scene)
    // Classic: WX-C's actor wetness (the ModelLibrary decorator), compiled once like a character on screen.
    expect(attachWetness(mat, 'actor')).not.toBeNull()
    expect(await ready(mesh)).toBe(true)
    const part = surfaces(scene)
    part.decorateCharacterMaterial(mat)
    expect(surfacePluginOf(mat)).toBeNull()
    // The live switch: RND-M dresses the recorded material, the post stack's height fog joins.
    part.setMode('pbr')
    attachFogPlugin(mat, new HeightFog(scene))
    expect(surfacePluginOf(mat)?.isEnabled).toBe(true)
    expect(mat.pluginManager?.getPlugin(WETNESS_PLUGIN)).not.toBeNull()
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const d = declared(mat, lang)
      expect(dupes(d.members), `duplicate UBO members (${lang === ShaderLanguage.WGSL ? 'WGSL' : 'GLSL'})`).toEqual([])
      expect(dupes(d.samplers), 'duplicate samplers').toEqual([])
      // The shelter members are declared, once, by the render plugin.
      for (const n of ['wxCam', 'wxOcc', 'wxOccM', 'wxF']) expect(d.members.filter(x => x === n)).toHaveLength(1)
      expect(d.samplers.filter(x => x === 'wxOccMap')).toHaveLength(1)
    }
    expect(await ready(mesh)).toBe(true)
    // Back to Classic and on again: still one declaration each, still ready.
    part.setMode('classic')
    expect(surfacePluginOf(mat)?.isEnabled).toBe(false)
    expect(dupes(declared(mat, ShaderLanguage.GLSL).members)).toEqual([])
    part.setMode('pbr')
    expect(dupes(declared(mat, ShaderLanguage.GLSL).members)).toEqual([])
    expect(dupes(declared(mat, ShaderLanguage.WGSL).members)).toEqual([])
    expect(await ready(mesh)).toBe(true)
  })

  it('every tier (Medium, High sheen, Ultra translucency) keeps one declaration per member', async () => {
    for (const preset of ['medium', 'high', 'ultra'] as const) {
      const scene = nullScene()
      const { mat, mesh } = character(scene, 'chinaman_adventurer_cloth')
      attachWetness(mat, 'actor')
      const part = surfaces(scene, preset)
      part.decorateCharacterMaterial(mat)
      part.setMode('pbr')
      part.setQuality(RENDER_PRESETS[preset])
      attachFogPlugin(mat, new HeightFog(scene))
      for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) expect(dupes(declared(mat, lang).members), `${preset} ${lang}`).toEqual([])
      expect(await ready(mesh), preset).toBe(true)
    }
  })

  it('the wetness plugin alone (Classic, no render plugin) still declares its full set', () => {
    const scene = nullScene()
    const { mat } = character(scene)
    attachWetness(mat, 'actor')
    const all = ['wxA', 'wxB', 'wxC', 'wxD', 'wxE', 'wxF', 'wxCam', 'wxOcc', 'wxOccM', 'wxMat']
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) {
      const d = declared(mat, lang)
      for (const n of all) expect(d.members, n).toContain(n)
      expect(d.samplers).toContain('wxOccMap')
      expect(renderDeclared(mat, lang).ubo.size).toBe(0)
    }
  })

  it('entering with the modern graphics on (dressed first): the wetness decorator skips it, one declaration each', () => {
    const scene = nullScene()
    const { mat } = character(scene)
    const part = surfaces(scene)
    part.setMode('pbr')
    part.decorateCharacterMaterial(mat)
    expect(attachWetness(mat, 'actor')).toBeNull()
    for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) expect(dupes(declared(mat, lang).members)).toEqual([])
  })
})

// ---- the prepass and render targets with their own camera ------------------------------------------------------------

/**
 * A scene with a prepass renderer that a camera post-process needs (a stand-in for SSR: reflectivity, depth and normal
 * targets). NullEngine has no multiple render targets, so enabling records the layout only (the state under test) and
 * the draw-time attachment calls are skipped. `atCamera` is the prepass state when the main camera starts drawing:
 * what SSR reads.
 */
function prepassScene() {
  const scene = nullScene()
  const engine = scene.getEngine()
  engine.getCaps().drawBuffersExtension = true
  engine.getCaps().textureHalfFloatRender = true
  const proto = PrePassRenderer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
  vi.spyOn(proto, '_enable').mockImplementation(function (this: unknown) {
    const pr = this as { _effectConfigurations: Array<{ enabled: boolean; texturesRequired: number[] }>; _enableTextures(t: number[]): void; _enabled: boolean }
    for (const c of pr._effectConfigurations) if (c.enabled) pr._enableTextures(c.texturesRequired)
    pr._enabled = true
  })
  for (const m of ['_setupOutputForThisPass', '_afterDraw', 'bindAttachmentsForEffect', '_bindFrameBuffer']) vi.spyOn(proto, m).mockImplementation(() => {})
  vi.spyOn(proto, '_clear').mockImplementation(function (this: unknown) {
    const pr = this as { _isDirty: boolean; _update(): void }
    if (pr._isDirty) pr._update()
  })
  const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const box = MeshBuilder.CreateBox('b', { size: 1 }, scene)
  const pr = scene.enablePrePassRenderer()!
  expect(pr).toBeTruthy()
  const ssr = new PostProcess('fakeSsr', 'pass', null, null, 1, camera)
  ;(ssr as unknown as { _prePassEffectConfiguration: unknown })._prePassEffectConfiguration = { name: 'fakeSsr', enabled: false, texturesRequired: [3, 5, 6] }
  const atCamera: Array<{ enabled: boolean; reflectivity: number }> = []
  scene.onBeforeCameraRenderObservable.add(c => {
    if (c === camera) atCamera.push({ enabled: pr.enabled, reflectivity: pr.getIndex(3) })
  })
  /** A render target with its own camera and no noPrePassRenderer flag, drawn before the camera every frame. */
  const ownCameraTarget = () => {
    const rtt = new RenderTargetTexture('own', 16, scene)
    rtt.activeCamera = new FreeCamera('ownCam', new Vector3(0, 50, 0), scene, false)
    rtt.renderList = [box]
    scene.customRenderTargets.push(rtt)
    return rtt
  }
  const frame = () => {
    scene.render()
    return atCamera.at(-1)!
  }
  return { scene, camera, box, pr, frame, ownCameraTarget }
}

describe('the prepass and render targets with their own camera', () => {
  it('Babylon 9.28: such a target turns the prepass off when it is dirty, and on its own first draw (why the fixes exist)', () => {
    const dirty = prepassScene()
    expect(dirty.frame()).toEqual({ enabled: true, reflectivity: expect.any(Number) })
    dirty.ownCameraTarget()
    dirty.pr.markAsDirty()
    expect(dirty.frame()).toEqual({ enabled: false, reflectivity: -1 })
    const first = prepassScene()
    expect(first.frame().enabled).toBe(true)
    first.ownCameraTarget()
    expect(first.frame()).toEqual({ enabled: false, reflectivity: -1 })
  })

  it('the weather shelter map never takes part in the prepass (noPrePassRenderer): SSR keeps its targets', () => {
    const { scene, box, pr, frame } = prepassScene()
    const shelter = new WeatherShelter(scene, () => [box])
    cleanups.push(() => shelter.dispose())
    expect(shelter.texture.noPrePassRenderer).toBe(true)
    expect(frame().enabled).toBe(true)
    // Rain: the map renders (its first draw), then the post stack is rebuilt (dirty) and it renders again.
    shelter.update({ x: 0, y: 0, z: 0 }, 1, 1, 0)
    expect(scene.customRenderTargets).toContain(shelter.texture)
    expect(frame().reflectivity).toBeGreaterThanOrEqual(0)
    shelter.markDirty()
    shelter.update({ x: 0, y: 0, z: 0 }, 1, 1, 10_000)
    pr.markAsDirty()
    expect(frame()).toEqual({ enabled: true, reflectivity: expect.any(Number) })
    expect(pr.getIndex(3)).toBeGreaterThanOrEqual(0)
    expect(shelter.renders).toBe(2)
  })

  it('RenderPost settles a dirty prepass against its camera before the render targets, and repairs a flip after them', () => {
    const { scene, camera, pr, frame, ownCameraTarget } = prepassScene()
    const render = new WorldRender(scene, { mode: 'pbr', quality: RENDER_PRESETS.medium, gpu: GPU })
    cleanups.push(() => render.dispose())
    vi.spyOn(console, 'warn').mockImplementation(() => {}) // NullEngine: no LUT grade
    const post = installRenderPost(render)
    render.attachCamera(camera)
    expect(post.stages.length).toBeGreaterThan(0)
    // NullEngine builds no SSR: the stand-in on the camera is the prepass stage the repair checks for.
    scene.onAfterRenderTargetsRenderObservable.add(() => post.repairPrepass(true))
    expect(frame().enabled).toBe(true)
    // A target's first draw flips it (not dirty): the repair has the camera read it again.
    ownCameraTarget()
    expect(frame()).toEqual({ enabled: true, reflectivity: expect.any(Number) })
    // Dirty (a rebuild) with the target drawn first: the settle reads it with the camera before the targets.
    pr.markAsDirty()
    const update = vi.spyOn(pr, 'update')
    expect(frame()).toEqual({ enabled: true, reflectivity: expect.any(Number) })
    expect(update).toHaveBeenCalled()
    expect(pr.getIndex(3)).toBeGreaterThanOrEqual(0)
    // A prepass nothing can turn on (no stage needs it any more) is re-read a few times, then left alone.
    const [fake] = camera._postProcesses.filter(p => p?.name === 'fakeSsr')
    camera.detachPostProcess(fake!)
    const dirty = vi.spyOn(pr, 'markAsDirty')
    for (let i = 0; i < 6; i++) frame()
    expect(pr.enabled).toBe(false)
    expect(dirty).toHaveBeenCalledTimes(PREPASS_REPAIRS_MAX)
    // Torn down (Classic): no settle any more, the stack's observers are gone.
    render.setMode('classic')
    expect(post.stages).toEqual([])
    update.mockClear()
    frame()
    expect(update).not.toHaveBeenCalled()
  })
})
