/**
 * W9A perf pass: main-camera actor culling (three/models.ts CharacterActor.cull, ModelLibrary.cullActors). Actor meshes
 * are always selected (skinned bounds do not follow the clips), so every actor was drawn even behind the camera; an
 * actor whose generous culling sphere is wholly outside the view is handed back to Babylon's own frustum test, one in
 * view stays always selected. The frame's active meshes drop the actor behind the camera and keep the one in front;
 * switching the culling off restores the old behaviour.
 */
import { ArcRotateCamera, AssetContainer, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { CULL_MARGIN_M, CULL_SPHERE_SCALE, CharacterActor, ModelLibrary, cullSphereOf } from '../src/three/models.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  // Looking down +Z from z = -10 (a left-handed scene).
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
  camera.minZ = 0.2
  camera.maxZ = 500
  const library = new ModelLibrary(scene)
  cleanups.push(() => {
    library.dispose()
    scene.dispose()
    engine.dispose()
  })
  /** A 1 × 2 × 1 m actor (one box standing on the root), registered with the library as `character()` does. */
  const actor = (name: string, at: [number, number, number]) => {
    const root = new TransformNode('__root__', scene)
    const body = MeshBuilder.CreateBox(`${name}_body`, { width: 1, height: 2, depth: 1 }, scene)
    body.position.y = 1
    body.parent = root
    const c = new AssetContainer(scene)
    c.transformNodes.push(root)
    c.meshes.push(body)
    c.removeAllFromScene()
    const a = new CharacterActor(scene, { code: 'MOB_TEST', glb: `/out/${name}.glb` }, { container: c, sidecar: null, packs: null })
    a.root.position.set(...at)
    const actors = (library as unknown as { actors: Set<CharacterActor> }).actors
    actors.add(a)
    a.root.onDisposeObservable.addOnce(() => actors.delete(a))
    return a
  }
  const active = () => {
    scene.render()
    const l = scene.getActiveMeshes()
    return Array.from({ length: l.length }, (_, i) => l.data[i]!.name)
  }
  return { scene, camera, library, actor, active }
}

describe('actor culling (W9A perf)', () => {
  it('the culling sphere covers the bind pose on every yaw, from the ground to at least 2 m, with a margin', () => {
    const s = cullSphereOf({ x: -0.5, y: 0, z: -0.3 }, { x: 0.4, y: 1.8, z: 0.3 })
    expect(s.y).toBe(1)
    expect(s.r).toBeCloseTo(CULL_SPHERE_SCALE * Math.hypot(0.5, 0.3, 1) + CULL_MARGIN_M, 9)
    // A floating bind (2.4..4.1 m) still reaches the ground; an empty model never culls.
    const f = cullSphereOf({ x: -1, y: 2.4, z: -1 }, { x: 1, y: 4.1, z: 1 })
    expect(f.y - f.r).toBeLessThan(0)
    expect(cullSphereOf({ x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: Number.MAX_VALUE }, { x: -Number.MAX_VALUE, y: -Number.MAX_VALUE, z: -Number.MAX_VALUE }).r).toBe(Infinity)
  })

  it('an actor behind the camera is not drawn; in front, at the edge and back in view it is; off restores HEAD', () => {
    const { library, actor, active } = setup()
    const front = actor('front', [0, 0, 5])
    const behind = actor('behind', [0, 0, -30])
    const edge = actor('edge', [0, 0, -11]) // its body is behind the near plane, the sphere is not
    expect(library.liveActors.size).toBe(3)
    const names = active()
    expect(names).toContain('front_body')
    expect(names).toContain('edge_body')
    expect(names).not.toContain('behind_body')
    expect([front.isOffscreen, behind.isOffscreen, edge.isOffscreen]).toEqual([false, true, false])
    expect(behind.allMeshes().every(m => !m.alwaysSelectAsActiveMesh)).toBe(true)
    expect(front.allMeshes().every(m => m.alwaysSelectAsActiveMesh)).toBe(true)
    // It walks into view: drawn in that same frame.
    behind.root.position.z = 8
    expect(active()).toContain('behind_body')
    expect(behind.isOffscreen).toBe(false)
    // Culling off: every actor always selected again.
    behind.root.position.z = -30
    active()
    expect(behind.isOffscreen).toBe(true)
    library.actorCulling = false
    active()
    expect(behind.isOffscreen).toBe(false)
    expect(behind.allMeshes().every(m => m.alwaysSelectAsActiveMesh)).toBe(true)
    // A disposed actor leaves the library.
    behind.dispose()
    expect(library.liveActors.has(behind)).toBe(false)
  })

  it('root scaling grows the sphere (a big monster at the edge of the view stays drawn)', () => {
    const { camera, actor, active } = setup()
    camera.fov = 0.8
    // About 7 m outside the side of the view (the NullEngine's 2:1 frame): out for a 1 m-wide actor, in for a 6× one.
    const small = actor('small', [26, 0, 10])
    const big = actor('big', [26, 0, 10])
    big.root.scaling.setAll(6)
    active()
    expect(small.isOffscreen).toBe(true)
    expect(big.isOffscreen).toBe(false)
  })
})
