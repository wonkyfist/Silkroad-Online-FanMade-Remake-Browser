/**
 * W9F adversarial hunt, lens "glsl". Tests that FAIL here are the findings.
 *
 * G1: the WebGL2 startup burst of the I9A report ("GL_INVALID_OPERATION: glDrawElements: It is undefined behaviour to
 * use a uniform buffer that is too small", 60-190 warnings on a cold shader cache) is the hit-light join at world
 * entry. Seen in the browser (WebGL2, Medium, shader cache busted): the dropped draws are character PBR programs
 * compiled for LIGHT0 DIR, LIGHT1 POINT, LIGHT2 POINT, LIGHT3 CLUST, drawn one frame after the join with Light2 = an
 * 80-byte directional block (the program wants 88) and Light3 = a 96-byte hemispheric block (it wants the 344-byte
 * cluster block). The frame order that makes it: world/features.ts runs skillsFeature (SkillFx.update ->
 * HitLights.update) BEFORE fxWorldFeature (attachNightLights + setHitLightCluster), so the frame that creates the
 * cluster renders with the two hit lights still plain scene lights: every lit material compiles a throwaway
 * [dir, point, point, cluster] program; the next frame the pool joins, the materials recompile, and Babylon's shader
 * hot-swap keeps drawing the throwaway program with the new light list until the new one links.
 *
 * NullEngine, the game's real HitLights and world-render's real NightLights (a fake host, as night-lights.test.ts).
 */
import {
  ClusteredLightContainer,
  DirectionalLight,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  UniversalCamera,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Light,
} from '@babylonjs/core'
import { RENDER_PRESETS, SharedUniforms, attachNightLights, type NightLightsHost } from '@sro/world-render'
import { afterEach, describe, expect, it } from 'vitest'
import type { NightLightQuality } from '../../../packages/world-render/src/render/quality.ts'
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

/** A NullEngine that looks like WebGL2 with float blending (ClusteredLightContainer.isSupported), as night-lights.test.ts. */
function clusterScene(): Scene {
  const engine = new NullEngine()
  const caps = engine.getCaps() as unknown as Record<string, unknown>
  caps.texelFetch = true
  caps.colorBufferFloat = true
  caps.blendFloat = true
  caps.shaderFloatPrecision = 23
  Object.defineProperty(engine as AbstractEngine, 'version', { value: 2, configurable: true })
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

/** The parts of World that NightLights reads (night-lights.test.ts's fake host). */
function fakeHost(scene: Scene, q: NightLightQuality): NightLightsHost {
  return {
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
    render: { quality: { nightLights: q }, weather: { rain: 0 } },
    skyState: { night: 0 },
    addCommitStep: () => () => {},
  } as unknown as NightLightsHost
}

type Kind = 'dir' | 'point' | 'hemi' | 'spot' | 'cluster'
const kindOf = (l: Light): Kind =>
  l instanceof ClusteredLightContainer ? 'cluster' : l instanceof HemisphericLight ? 'hemi' : l instanceof DirectionalLight ? 'dir' : l instanceof PointLight ? 'point' : 'spot'

function characterMesh(scene: Scene): AbstractMesh {
  const m = MeshBuilder.CreateBox('character', { size: 1 }, scene)
  m.material = new PBRMaterial('characterMat', scene)
  return m
}

describe('G1: the frame that creates the night-light cluster renders the hit lights as plain point lights', () => {
  it('world entry on Medium: no rendered frame has both the hit lights and the cluster in a material light list', () => {
    const scene = clusterScene()
    new DirectionalLight('celestial', new Vector3(-0.4, -1, -0.5).normalize(), scene)
    const now = { t: 0 }
    // SkillFx (skillsFeature) makes its hit-light pool when the world screen starts, long before the night lights.
    const hits = new HitLights(scene, () => now.t)
    cleanups.unshift(() => hits.dispose())
    const who = characterMesh(scene)
    // Frames before the night lights exist: the pool finds no cluster and stays two scene point lights (by design).
    hits.update()
    expect(who.lightSources.map(kindOf)).toEqual(['dir', 'point', 'point'])

    // The frame that attaches them, in world/features.ts order:
    now.t += 16
    //   1. skillsFeature.onFrame -> SkillFx.update -> HitLights.update: still no cluster registered.
    hits.update()
    //   2. fxWorldFeature.onFrame: attachNightLights (its constructor builds the ClusteredLightContainer at once on
    //      Medium) and setHitLightCluster, the two lines of fx-world.ts.
    const nl = attachNightLights(fakeHost(scene, RENDER_PRESETS.medium.nightLights), { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    setHitLightCluster(nl)
    expect(nl.points?.mode).toBe('cluster')
    //   3. scene.render(): every lit material prepares its defines from this list and compiles a program for it.
    const renderedWith = who.lightSources.map(kindOf)

    // The next frame the pool joins (and every material recompiles, hot-swapping from the program above).
    now.t += 16
    hits.update()
    expect(hits.clustered).toBe(2)
    const after = who.lightSources.map(kindOf)
    expect(after).toEqual(['dir', 'cluster'])

    // What should hold: the cluster and the hit lights become visible to the materials together, so no frame renders
    // (and no material compiles) the transitional [dir, point, point, cluster] list. Fails today: the frame that
    // creates the cluster renders it.
    expect(renderedWith).toEqual(after)
  })
})
