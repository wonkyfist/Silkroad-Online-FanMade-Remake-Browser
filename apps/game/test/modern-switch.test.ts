/**
 * Wave 9A hotfix: every player, mob and NPC survives the live switch to the modern graphics (Options → "Modern
 * graphics (preview)" → WorldGraphics.apply → World.setRenderMode on a streamed world), and every switch after it.
 *
 * Headless and as in the game: a streamed World (world-render's synthetic fixture) with its RegionStreamer, the
 * world screen's WorldGraphics with the game's settings store, a ModelLibrary whose containers the two game decorators
 * dress (GAME's `graphics.decorate` and WX-C's Classic actor wetness from the real weather feature), and live entity
 * meshes that share the containers' materials (ModelLibrary instances do). After each switch every entity mesh keeps
 * its live material, on the right path, ready, with each uniform-block member declared once in GLSL and WGSL (two
 * plugins declaring the same member failed the WebGL2 shader and Babylon skipped every character).
 */
import {
  AssetContainer,
  DirectionalLight,
  FreeCamera,
  HemisphericLight,
  MeshBuilder,
  PBRMaterial,
  ShaderLanguage,
  TransformNode,
  Vector3,
  type BaseTexture,
  type Material,
  type Mesh,
  type Scene,
} from '@babylonjs/core'
import { RegionStreamer, STREAM_DEFAULTS, surfacePluginOf, type World } from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeModels, makeFixture, makeWorld, settle } from '../../../packages/world-render/test/stream-fixture.ts'
import { SettingsStore, type GraphicsPreset } from '../src/settings.ts'
import { ModelLibrary } from '../src/three/models.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { weatherFeature } from '../src/world/features/weather.ts'
import { PBR_CHARACTER_LIGHTS, WorldGraphics } from '../src/world/graphics.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

/** The member names of a plugin UBO declaration, GLSL (`vec4 name;`) or WGSL (`uniform name: vec4f;`). */
const memberNames = (decl: string) =>
  decl
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => /^uniform\s+(\w+)\s*:/.exec(l)?.[1] ?? /^\w+\s+(\w+)/.exec(l)?.[1] ?? l)
const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))]

/** Builds the material's uniform layout in `lang` and returns the members its plugins declared more than once. */
function duplicateMembers(mat: Material, lang: ShaderLanguage): string[] {
  const m = mat as unknown as { _shaderLanguage: ShaderLanguage; buildUniformLayout(): void }
  const was = m._shaderLanguage
  m._shaderLanguage = lang
  try {
    m.buildUniformLayout()
  } finally {
    m._shaderLanguage = was
  }
  const pm = mat.pluginManager as unknown as { _uboDeclaration: string; _samplerList: string[] } | null
  if (!pm) return []
  return [...dupes(memberNames(pm._uboDeclaration)), ...dupes(pm._samplerList).map(s => `sampler ${s}`)]
}

/** Prepares the defines and waits for the (NullEngine) effect: the first call compiles, a later one is ready. */
async function ready(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material!
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

/** A streamed world as the game plays it (jangan-fields), with its streamer settled around the origin region. */
async function streamedWorld(): Promise<{ scene: Scene; world: World; pump: () => Promise<void> }> {
  const fx = makeFixture()
  const { engine, scene, world, chunks } = await makeWorld(fx)
  const models = fakeModels(scene)
  const stream = new RegionStreamer(world, { ...STREAM_DEFAULTS.medium }, {
    now: () => 0, autoPump: false, objects: true, nav: chunks, loadModel: models.loadModel, disposeModel: models.disposeModel,
    atlas: { create: () => ({ dispose() {}, getInternalTexture: () => null }) as unknown as BaseTexture, upload: () => true },
  })
  world.stream = stream
  stream.booting = false
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  const focus = { x: 96, z: -96 }
  const pump = async () => {
    for (let i = 0; i < 400; i++) {
      stream.update(focus, null)
      await settle(2)
      if (stream.stats.ready === stream.stats.wanted && !stream.stats.jobs) return
    }
  }
  await pump()
  return { scene, world, pump }
}

/** The world screen's pieces around a world: lights, camera, WorldGraphics, the ModelLibrary and its decorators. */
function worldScreen(scene: Scene, world: World, store: SettingsStore) {
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // NullEngine: no LUT grade, no clustered lights
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
  const camera = new FreeCamera('cam', new Vector3(96, 20, -110), scene)
  camera.setTarget(new Vector3(96, 0, -96))
  scene.activeCamera = camera
  const graphics = new WorldGraphics({ world, camera, lights: { hemi, sun }, store, rollout: 'preview' })
  const library = new ModelLibrary(scene)
  // screens/world.ts: RND-M's decoration first, then WX-C's feature adds its Classic actor wetness on its first frame.
  const offDecorator = library.addMaterialDecorator(mat => graphics.decorate(mat))
  const weather = weatherFeature({
    scene,
    camera: { target: new Vector3(96, 0, -96), position: camera.position },
    serverNow: () => 0,
    selfId: () => null,
    view: () => undefined,
    world: () => ({ world }),
    addMaterialDecorator: fn => library.addMaterialDecorator(fn),
  } as unknown as WorldFeatureContext, { store, search: '', zoneAt: () => null })
  weather.onFrame!(0, 0.016)
  cleanups.push(() => {
    weather.dispose!()
    offDecorator()
    graphics.dispose()
    library.dispose()
  })
  /** A loaded character glb (a player, a mob, an NPC) and `count` live instances sharing its materials. */
  let n = 0
  const entity = (glb: string, materials: string[], count = 2) => {
    const c = new AssetContainer(scene)
    for (const name of materials) {
      const m = new PBRMaterial(name, scene)
      m.maxSimultaneousLights = 5
      c.materials.push(m)
    }
    ;(library as unknown as { noteLoaded(c: AssetContainer, glb: string): void }).noteLoaded(c, glb)
    const meshes: Mesh[] = []
    for (let i = 0; i < count; i++) {
      const root = new TransformNode(`entity${n}:${n}`, scene)
      n++
      for (const mat of c.materials) {
        const mesh = MeshBuilder.CreateBox(`${mat.name}:${i}`, { size: 1 }, scene)
        mesh.parent = root
        mesh.material = mat
        meshes.push(mesh)
        world.render.addCharacter(mesh)
      }
    }
    return { container: c, meshes }
  }
  return { graphics, library, entity, camera, weather }
}

/** Every entity mesh has its container's live material, on the world's path, ready, each member declared once. */
async function expectEntitiesAlive(world: World, entities: ReadonlyArray<{ container: AssetContainer; meshes: Mesh[] }>, label: string): Promise<void> {
  const pbr = world.render.mode === 'pbr'
  for (const { container, meshes } of entities) {
    for (const mesh of meshes) {
      const mat = mesh.material as PBRMaterial | null
      const at = `${label}: ${mesh.name}`
      expect(mesh.isDisposed(), at).toBe(false)
      expect(mesh.isEnabled() && mesh.isVisible, at).toBe(true)
      expect(mat, at).not.toBeNull()
      expect(container.materials, at).toContain(mat)
      expect(mesh.getScene().materials, `${at} (material disposed)`).toContain(mat)
      expect(!!surfacePluginOf(mat!)?.isEnabled, `${at} (path ${world.render.mode})`).toBe(pbr)
      expect(mat!.maxSimultaneousLights, at).toBe(pbr ? PBR_CHARACTER_LIGHTS : 5)
      for (const lang of [ShaderLanguage.GLSL, ShaderLanguage.WGSL]) expect(duplicateMembers(mat!, lang), `${at} (${lang === ShaderLanguage.WGSL ? 'WGSL' : 'GLSL'})`).toEqual([])
      expect(await ready(mesh), `${at} (ready)`).toBe(true)
    }
  }
}

function classicStore(preset: GraphicsPreset = 'medium'): SettingsStore {
  const store = new SettingsStore(null)
  store.set({ graphics: { preset, modern: false } })
  return store
}

describe('the live switch to the modern graphics keeps every entity (headless, the game toggle path)', () => {
  it('Classic entry → on → off → on → High → Ultra → Medium: every player, mob and NPC keeps a live material of the right path', async () => {
    const { scene, world, pump } = await streamedWorld()
    const store = classicStore()
    const { entity, weather } = worldScreen(scene, world, store)
    const entities = [
      entity('/out-opt/char/china/chinaman_adventurer.glb', ['chinaman_adventurer_body', 'chinaman_adventurer_hair', 'ch_m_clothes_01_ba']),
      entity('/out-opt/monster/mangnyang.glb', ['mangnyang'], 3),
      entity('/out-opt/npc/npc/ch_smith.glb', ['ch_smith_body']),
    ]
    expect(world.render.mode).toBe('classic')
    await expectEntitiesAlive(world, entities, 'classic entry')
    // WX-C wets them on Classic (so the switch lands on materials that already carry the wetness plugin).
    expect(entities[0]!.container.materials.every(m => !!m.pluginManager?.getPlugin('WetnessPlugin'))).toBe(true)

    const steps: Array<[string, Parameters<SettingsStore['set']>[0]]> = [
      ['toggle on', { graphics: { modern: true } }],
      ['toggle off', { graphics: { modern: false } }],
      ['toggle on again', { graphics: { modern: true } }],
      ['High while on', { graphics: { preset: 'high' } }],
      ['Ultra while on', { graphics: { preset: 'ultra' } }],
      ['Medium while on', { graphics: { preset: 'medium' } }],
    ]
    for (const [label, patch] of steps) {
      store.set(patch)
      weather.onFrame!(0, 0.016)
      await pump()
      expect(world.render.mode, label).toBe(store.get().graphics.modern ? 'pbr' : 'classic')
      await expectEntitiesAlive(world, entities, label)
    }
    // A character loaded after the switch (a mob walking into view) is dressed at once.
    const late = entity('/out-opt/monster/tiger.glb', ['tiger'])
    await expectEntitiesAlive(world, [...entities, late], 'loaded while on')
  })

  it('entering with the toggle already on, and char select → world → char select, keep them too', async () => {
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'high', modern: true } })
    for (const visit of [1, 2]) {
      const { scene, world } = await streamedWorld()
      const { entity } = worldScreen(scene, world, store)
      // The world loads Classic and WorldGraphics' first apply switches it (a streamed world rebuilds).
      expect(world.render.mode, `visit ${visit}`).toBe('pbr')
      const entities = [entity('/out-opt/char/china/chinawoman_adventurer.glb', ['chinawoman_body', 'chinawoman_hair']), entity('/out-opt/monster/mangnyang.glb', ['mangnyang'])]
      await expectEntitiesAlive(world, entities, `entered on, visit ${visit}`)
      store.set({ graphics: { modern: false } })
      await expectEntitiesAlive(world, entities, `turned off, visit ${visit}`)
      store.set({ graphics: { modern: true } })
      await expectEntitiesAlive(world, entities, `turned on, visit ${visit}`)
      for (const c of cleanups.splice(0).reverse()) c()
    }
  })
})
