/**
 * W9F adversarial hunt, lens "lights": light index 0 is the celestial light; the light count is constant at dusk, when
 * the cluster fills and with hit lights; no recompile on these events. NullEngine, the game's real HitLights and
 * world-render's real WorldLighting / NightLights / World. Tests that FAIL here are the findings.
 */
import {
  ClusteredLightContainer,
  DirectionalLight,
  Effect,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  UniformBuffer,
  UniversalCamera,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Light,
} from '@babylonjs/core'
import {
  CELESTIAL_LIGHT_NAME,
  NightLights,
  RENDER_PRESETS,
  SharedUniforms,
  WorldLighting,
  attachNightLights,
  loadWorld,
  type NightLightsHost,
} from '@sro/world-render'
import { afterEach, describe, expect, it } from 'vitest'
import type { NightLightQuality } from '../../../packages/world-render/src/render/quality.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { HitLights, setHitLightCluster } from '../src/world/fx/hit-light.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // best effort
    }
  }
  setHitLightCluster(null)
})

function newScene(clusters: boolean): Scene {
  const engine = new NullEngine()
  if (clusters) enableClusters(engine)
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const cam = new UniversalCamera('cam', new Vector3(0, 5, -10), scene)
  cam.setTarget(Vector3.Zero())
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

/** As night-lights.test.ts: the NullEngine looks like a WebGL2 engine with float blending (clusters supported). */
function enableClusters(engine: AbstractEngine): void {
  const caps = engine.getCaps() as unknown as Record<string, unknown>
  caps.texelFetch = true
  caps.colorBufferFloat = true
  caps.blendFloat = true
  caps.shaderFloatPrecision = 23
  Object.defineProperty(engine, 'version', { value: 2, configurable: true })
}

/** The game's character lights (screens/world.ts buildWorldScene), off on the PBR path (world/graphics.ts syncPath). */
function gameLights(scene: Scene): void {
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5).normalize(), scene)
  hemi.setEnabled(false)
  sun.setEnabled(false)
}

/** A fake NightLights host (the parts NightLights reads), as night-lights.test.ts. */
function fakeHost(scene: Scene, q: NightLightQuality): { host: NightLightsHost; quality: { nightLights: NightLightQuality } } {
  const quality = { nightLights: q }
  const host: NightLightsHost = {
    scene,
    assets: { json: async <T>() => ({ models: {} }) as T },
    objects: { addRegionListener: () => () => {} },
    terrain: {
      sharedUniforms: new SharedUniforms(),
      setRegionTexture: () => true,
      setDefine: () => {},
      onRegionDisposed: { add: () => null, remove: () => true },
    },
    scatter: { sharedUniforms: new SharedUniforms(), setDefine: () => {} },
    render: { quality, weather: { rain: 0 } },
    skyState: { night: 0 },
    addCommitStep: () => () => {},
  } as unknown as NightLightsHost
  return { host, quality }
}

/** A terrain-like PBR mesh: default layer mask (not WORLD_OBJECT_LAYER), Babylon's default 4 lights. */
function pbrMesh(scene: Scene, name: string): AbstractMesh {
  const m = MeshBuilder.CreateBox(name, { size: 1 }, scene)
  const mat = new PBRMaterial(`${name}Mat`, scene)
  mat.useGLTFLightFalloff = true
  m.material = mat
  return m
}

type Kind = 'dir' | 'point' | 'hemi' | 'spot' | 'cluster'
const kindOf = (l: Light): Kind =>
  l instanceof ClusteredLightContainer ? 'cluster' : l instanceof HemisphericLight ? 'hemi' : l instanceof DirectionalLight ? 'dir' : l instanceof PointLight ? 'point' : 'spot'

/** The light layout an effect was compiled for (LIGHTn + its type define). */
function effectLayout(effect: Effect): Kind[] {
  const d = effect.defines
  const out: Kind[] = []
  for (let i = 0; i < 8; i++) {
    if (!new RegExp(`#define LIGHT${i}\\b`).test(d)) break
    if (new RegExp(`#define CLUSTLIGHT${i}\\b`).test(d)) out.push('cluster')
    else if (new RegExp(`#define DIRLIGHT${i}\\b`).test(d)) out.push('dir')
    else if (new RegExp(`#define POINTLIGHT${i}\\b`).test(d)) out.push('point')
    else if (new RegExp(`#define HEMILIGHT${i}\\b`).test(d)) out.push('hemi')
    else out.push('spot')
  }
  return out
}

describe('light 0 is the celestial light (holds)', () => {
  it('stays first through the game order: character lights, hit lights, world, cluster, hit-light join, preset swap', () => {
    const scene = newScene(true)
    gameLights(scene)
    const now = { t: 0 }
    const hits = new HitLights(scene, () => now.t)
    cleanups.unshift(() => hits.dispose())
    const early = pbrMesh(scene, 'early')
    const lighting = new WorldLighting(scene, { quality: RENDER_PRESETS.medium })
    cleanups.unshift(() => lighting.dispose())
    const f = fakeHost(scene, RENDER_PRESETS.medium.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    setHitLightCluster(nl)
    const cel = scene.getLightByName(CELESTIAL_LIGHT_NAME)!
    const check = () => {
      expect(scene.lights[0]).toBe(cel)
      expect(early.lightSources[0]).toBe(cel)
      expect(pbrMesh(scene, `late${now.t}`).lightSources[0]).toBe(cel)
    }
    check()
    hits.update()
    expect(hits.clustered).toBe(2)
    check()
    f.quality.nightLights = RENDER_PRESETS.ultra.nightLights
    nl.update()
    check()
    now.t += 1500
    hits.update()
    expect(hits.clustered).toBe(2)
    check()
  })
})

describe('finding L1: the hit-light cluster join shifts light slots with no "lights disposed" guard', () => {
  it('a hot-swapped effect keeps drawing with a light list it was not compiled for', async () => {
    const scene = newScene(true)
    gameLights(scene)
    const now = { t: 0 }
    // The game makes its hit lights (SkillFx) before the world and its night cluster.
    const hits = new HitLights(scene, () => now.t)
    cleanups.unshift(() => hits.dispose())
    const lighting = new WorldLighting(scene, { quality: RENDER_PRESETS.medium })
    cleanups.unshift(() => lighting.dispose())
    const terrain = pbrMesh(scene, 'terrainLike')
    const f = fakeHost(scene, RENDER_PRESETS.medium.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    expect(nl.points?.mode).toBe('cluster')
    // In a browser the cluster's proxy program is built at the first frame; the NullEngine never finishes it (its
    // extraInitializationsAsync import), so it stands in as ready here.
    const container = nl.points!.container! as unknown as { _isReady(): boolean }
    container._isReady = () => true
    // Before the join (the first frames of every world entry, and ~1 s after every Medium/High/Ultra switch).
    expect(terrain.lightSources.map(kindOf)).toEqual(['dir', 'point', 'point', 'cluster'])
    // The first frames compile it (the NullEngine loads the pbr shader sources asynchronously).
    for (let i = 0; i < 200 && !terrain.subMeshes[0]?.effect?.isReady(); i++) {
      scene.render()
      await new Promise(r => setTimeout(r, 10))
    }
    scene.render()
    const sub = terrain.subMeshes[0]!
    const e1 = sub.effect!
    expect(e1).toBeTruthy()
    expect(effectLayout(e1)).toEqual(['dir', 'point', 'point', 'cluster'])

    // The join: ClusteredLightContainer.addLight -> scene.removeLight -> mesh._removeLightSource(light, false).
    setHitLightCluster(nl)
    hits.update()
    expect(hits.clustered).toBe(2)
    expect(terrain.lightSources.map(kindOf)).toEqual(['dir', 'cluster'])

    // A cold shader cache (a first visit, a new build): the NEW PBR program is not ready for some frames.
    const origReady = Effect.prototype.isReady
    Effect.prototype.isReady = function (this: Effect) {
      if (this !== e1 && /pbr/i.test(JSON.stringify(this.name))) return false
      return origReady.call(this)
    }
    const bound: string[] = []
    const origBind = UniformBuffer.prototype.bindToEffect
    UniformBuffer.prototype.bindToEffect = function (this: UniformBuffer, effect: Effect, name: string) {
      if (effect === e1) bound.push(name)
      return origBind.call(this, effect, name)
    }
    try {
      scene.render()
    } finally {
      Effect.prototype.isReady = origReady
      UniformBuffer.prototype.bindToEffect = origBind
    }
    const lightBlocks = bound.filter(n => /^Light\d$/.test(n))
    // Before the fix the frame drew e1 (compiled for dir, point, point, cluster) and bound Light0 (celestial) and
    // Light1 = the CLUSTER's uniform buffer into a slot declared as a point light; Light2 / Light3 (the cluster block,
    // with vSliceRanges[16]) and lightDataTexture3 / tileMaskTexture3 kept whatever was bound before. Babylon skips the
    // frame only when a light was DISPOSED (PBRBaseMaterial.isReadyForSubMesh `lightDisposed`), so the join now marks
    // the meshes that way (fx/hit-light.ts). What must hold: no draw of an effect compiled for another layout. The
    // join did change the layout, so the old program must not be drawn; the mesh waits for the new one.
    // (W9F fix-game: the original assertion demanded a draw with a matching effect in a frame where that effect is not
    // compiled yet, which no Babylon path can give; skipping the draw is the fix L1 names.)
    expect(effectLayout(e1)).not.toEqual(terrain.lightSources.slice(0, 4).map(kindOf))
    expect({ drewOldEffect: sub.effect === e1 && lightBlocks.length > 0, bound: lightBlocks }).toEqual({ drewOldEffect: false, bound: [] })
    // Once the new program is ready it is drawn, compiled for the list the mesh has.
    for (let i = 0; i < 200 && (sub.effect === e1 || !sub.effect?.isReady()); i++) {
      scene.render()
      await new Promise(r => setTimeout(r, 10))
    }
    expect(effectLayout(sub.effect!)).toEqual(['dir', 'cluster'])
  })
})

describe('finding L2: a preset switch sends the hit lights back into every light list for ~1 s', () => {
  it('Medium -> High with clusters: the character light list changes twice (a throwaway compile of every material)', () => {
    const scene = newScene(true)
    gameLights(scene)
    const now = { t: 0 }
    const hits = new HitLights(scene, () => now.t)
    cleanups.unshift(() => hits.dispose())
    const lighting = new WorldLighting(scene, { quality: RENDER_PRESETS.medium })
    cleanups.unshift(() => lighting.dispose())
    const who = pbrMesh(scene, 'character')
    const f = fakeHost(scene, RENDER_PRESETS.medium.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    setHitLightCluster(nl)
    hits.update()
    expect(hits.clustered).toBe(2)
    const layouts: string[] = [who.lightSources.map(kindOf).join(',')]
    // Options -> High (NightLights.applyQuality: the old cluster goes, a new one of 32 comes).
    f.quality.nightLights = RENDER_PRESETS.high.nightLights
    nl.update()
    // Only a changed layout is recorded (as in the loop below); the new container is a different light of the same kind.
    const after = who.lightSources.map(kindOf).join(',')
    if (after !== layouts[layouts.length - 1]) layouts.push(after)
    expect(nl.points?.container?.lights.filter(l => l.name.startsWith('fx:hitlight')).length, 'the hit lights moved into the new cluster in the same call').toBe(2)
    // The pools try again once a second (CLUSTER_RETRY_MS).
    for (let i = 1; i <= 12; i++) {
      now.t += 100
      hits.update()
      nl.update()
      const l = who.lightSources.map(kindOf).join(',')
      if (l !== layouts[layouts.length - 1]) layouts.push(l)
    }
    expect(hits.clustered).toBe(2)
    // One layout before and after the switch (the new container is a new light, but the same slot kinds): no
    // intermediate 'dir,point,point,cluster' state that every character, terrain and water material compiles for.
    expect(layouts).toEqual(['dir,cluster'])
  })
})

describe('finding L3: without cluster support the PBR terrain drops a night point light', () => {
  it('pool fallback: celestial + 2 hit lights + 2 pool lights = 5 on a 4-light terrain material', async () => {
    const scene = newScene(false)
    gameLights(scene)
    const now = { t: 0 }
    const hits = new HitLights(scene, () => now.t)
    cleanups.unshift(() => hits.dispose())
    const w = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: makeFixture().io, minimap: false, objects: false, stream: false, quality: 'medium', render: 'pbr' })
    cleanups.unshift(() => w.dispose())
    const nl = attachNightLights(w, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    setHitLightCluster(nl)
    hits.update()
    expect(nl.points?.mode).toBe('pool')
    expect(hits.clustered).toBe(0)
    const t = w.terrain.meshes[0]!
    const mat = t.material as PBRMaterial
    expect(mat).toBeInstanceOf(PBRMaterial)
    const used = t.lightSources.slice(0, mat.maxSimultaneousLights).map(l => l.name)
    expect(used[0]).toBe(CELESTIAL_LIGHT_NAME)
    // Both night pool lights should reach the terrain (High and Ultra have no terrain splat: D29 says the point lights
    // light it); the hit flashes are "characters only" (fx/hit-light.ts).
    expect({ used, max: mat.maxSimultaneousLights }).toEqual({
      used: [CELESTIAL_LIGHT_NAME, 'nl:light0', 'nl:light1'],
      max: mat.maxSimultaneousLights,
    })
  })
})
