/**
 * W9 finish A adversarial hunt, lens = cpu (per-frame work, the upload budget, the animation LOD). Each `it` proves one
 * finding and FAILS on ef535d4; nothing here fixes product code.
 *
 * 1. setHighlightOverlay (world-render render/post.ts) adds a fresh onDisposeObservable observer to every mesh on every
 *    off -> on hover cycle: the observers pile up on long-lived meshes (NPCs, the player, pooled drops).
 * 2. The actor texture swaps (three/actor-textures.ts) run their upload jobs on their own frameScheduler (3 ms) in every
 *    scene, the world included, so a frame in which the region streamer already spent its High budget (5 ms) still
 *    runs ~3 ms more of actor uploads: the budgets add up instead of sharing the streamer's MAP_PRIORITY queue.
 * 3. The animation LOD skips Babylon evaluations, but RuntimeAnimation advances its blend factor per evaluation
 *    (blendingSpeed 0.08), so a far actor's clip change blends over 13 updates: 3x (20 Hz) to 6x (10 Hz) longer in
 *    time, and its pose on an update frame is no longer the pose an every-frame actor has.
 */
import { Animation, AnimationGroup, ArcRotateCamera, AssetContainer, MeshBuilder, NullEngine, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAM_DEFAULTS, setHighlightOverlay, HIGHLIGHT_COLOR, loadWorld } from '@sro/world-render'
import { ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { CharacterActor, ModelLibrary } from '../src/three/models.ts'
import { ACTOR_UPLOAD_BUDGET_MS, actorTexturesFor } from '../src/three/actor-textures.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) c()
})

function bareScene() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

describe('F1 hover highlight: observers pile up per hover cycle', () => {
  it('toggling a mesh highlight on and off 50 times leaves one dispose observer, not 50', () => {
    const scene = bareScene()
    const mesh = MeshBuilder.CreateBox('npc_body', { size: 1 }, scene)
    const before = mesh.onDisposeObservable.observers.length
    for (let i = 0; i < 50; i++) {
      setHighlightOverlay(mesh, HIGHLIGHT_COLOR) // the pointer enters the NPC
      setHighlightOverlay(mesh, null) // and leaves it
    }
    // One observer at most is needed for the OVERLAYS cleanup; ef535d4 leaves 50 (one closure per hover).
    expect(mesh.onDisposeObservable.observers.length - before).toBeLessThanOrEqual(1)
  })
})

describe('F2 actor uploads: a second frame budget on top of the streamer', () => {
  // W9F fix-game: the original repro simulated the streamer with a clock hook in a scene without one, which no
  // scheduler can see. The fix (the finding's first option) hands the actor swaps the real streamer's map scheduler in
  // the world (screens/world.ts -> ActorTextures.useScheduler), so this runs a streamed fixture world instead.
  it('in the world, actor upload jobs run inside the frame budget of the streamer, none on top of it', async () => {
    const scene = bareScene()
    scene.useRightHandedSystem = true
    const camera = new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene)
    const w = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: makeFixture().io, minimap: false, objects: false, stream: true, quality: 'high' })
    cleanups.unshift(() => w.dispose())
    const stream = w.stream!
    stream.booting = false
    // screens/world.ts, once the world is in.
    const textures = actorTexturesFor(scene)
    textures.useScheduler(stream.mapScheduler)
    expect(textures.maps.cache.scheduler).toBe(stream.mapScheduler)
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let ran = 0
    // Upload bands of a few decoded actor maps: 1 ms each on the main thread.
    for (let i = 0; i < 20; i++) {
      textures.maps.cache.scheduler.job(() => {
        ran++
        clock += 1
      })
    }
    // A frame's own hooks run none of them (no second budget in onBeforeRender)...
    scene.render()
    expect(ran).toBe(0)
    // ...the streamer's pass runs them within its budget (plus at most one job's overrun).
    const streamBudget = STREAM_DEFAULTS.high.frameBudgetMs
    stream.setSettings({ frameBudgetMs: streamBudget })
    const t0 = clock
    w.update(camera)
    expect(ran).toBeGreaterThan(0)
    expect(clock - t0).toBeLessThanOrEqual(streamBudget + 1)
    expect(ACTOR_UPLOAD_BUDGET_MS).toBeGreaterThan(0)
    // Leaving the world hands new work back to the scene's own scheduler.
    textures.useScheduler(null)
    expect(textures.maps.cache.scheduler).not.toBe(stream.mapScheduler)
  })
})

describe('F3 animation LOD: blends stretch with the LOD rate', () => {
  const FRAME_MS = 16
  function setup() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useConstantAnimationDeltaTime = true
    const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
    camera.minZ = 0.2
    camera.maxZ = 1000
    const library = new ModelLibrary(scene)
    library.animLod = true // W9F LG-5: off by default without the new look
    let clock = 0
    library.now = () => clock
    cleanups.push(() => {
      library.dispose()
      scene.dispose()
      engine.dispose()
    })
    const actor = (name: string, at: [number, number, number]) => {
      const root = new TransformNode('__root__', scene)
      const joint = new TransformNode('J', scene)
      joint.parent = root
      const body = MeshBuilder.CreateBox(`${name}_body`, { width: 1, height: 2, depth: 1 }, scene)
      body.position.y = 1
      body.parent = root
      const skeleton = new Skeleton(`${name}_skel`, `${name}_skel`, scene)
      body.skeleton = skeleton
      const c = new AssetContainer(scene)
      c.transformNodes.push(root, joint)
      c.meshes.push(body)
      c.skeletons.push(skeleton)
      const clip = (clipName: string, frames: number, from: number, to: number) => {
        const anim = new Animation(`${clipName}_x`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
        anim.setKeys([
          { frame: 0, value: new Vector3(from, 0, 0) },
          { frame: frames, value: new Vector3(to, 0, 0) },
        ])
        const g = new AnimationGroup(clipName, scene)
        g.addTargetedAnimation(anim, joint)
        c.animationGroups.push(g)
      }
      // STAND1 holds J.x near 0; ATTACK1 (a 2 s one-shot) holds it near 10: the blend between them is plain to see.
      clip('STAND1', 30, 0, 0.001)
      clip('ATTACK1', 60, 10, 10.001)
      c.removeAllFromScene()
      const a = new CharacterActor(scene, { code: 'MOB_TEST', glb: `/out/${name}.glb` }, { container: c, sidecar: null, packs: null })
      a.root.position.set(...at)
      const actors = (library as unknown as { actors: Set<CharacterActor> }).actors
      actors.add(a)
      a.root.onDisposeObservable.addOnce(() => actors.delete(a))
      return a
    }
    const frame = () => {
      clock += FRAME_MS
      scene.render()
    }
    const x = (a: CharacterActor) => a.joint('J')!.position.x
    return { actor, frame, x }
  }

  it('a far actor finishes a clip-change blend when an every-frame actor does (within one LOD interval)', () => {
    const { actor, frame, x } = setup()
    // 2 m tall at ~60 m: the 20 Hz tier (an update every 3 frames), like anim-lod.test.ts.
    const far = actor('far', [0, 0, 50])
    const ref = actor('ref', [0.5, 0, 50])
    ref.lodFull = true
    far.play('STAND1')
    ref.play('STAND1')
    for (let i = 0; i < 10; i++) frame()
    // The clip change blends (blendingSpeed 0.08 per evaluation: ~13 evaluations).
    far.playAction(far.group('ATTACK1')!)
    ref.playAction(ref.group('ATTACK1')!)
    let refDone = -1
    let farDone = -1
    for (let n = 0; n < 80 && farDone < 0; n++) {
      frame()
      if (refDone < 0 && x(ref) > 9.99) refDone = n
      if (farDone < 0 && x(far) > 9.99) farDone = n
    }
    expect(refDone).toBeGreaterThan(0)
    // At most one 20 Hz interval (3 frames) later. ef535d4: ~39 frames against ~13 (0.62 s against 0.21 s).
    expect((farDone - refDone) * FRAME_MS).toBeLessThanOrEqual(1000 / 20)
  })

  it('mid-blend, a far actor on its update frame shows the pose an every-frame actor shows', () => {
    const { actor, frame, x } = setup()
    const far = actor('far', [0, 0, 50])
    const ref = actor('ref', [0.5, 0, 50])
    ref.lodFull = true
    far.play('STAND1')
    ref.play('STAND1')
    for (let i = 0; i < 10; i++) frame()
    far.playAction(far.group('ATTACK1')!)
    ref.playAction(ref.group('ATTACK1')!)
    let worst = 0
    for (let n = 0; n < 30; n++) {
      frame()
      if (!far.lodSkipping) worst = Math.max(worst, Math.abs(x(far) - x(ref)))
    }
    // The LOD's contract (models.ts ANIM_LOD): "a pose is always where it would be, only held longer".
    expect(worst).toBeLessThan(0.05)
  })
})
