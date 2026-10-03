/**
 * PERF2: the animation cost of the actors (three/models.ts).
 * - Pooled key interpolation: the CYCLE clips' Slerp/Lerp write into one scratch value per Animation (no garbage per
 *   track per frame), give the same poses as Babylon's own functions, and the other loop modes keep Babylon's.
 * - Animation LOD: a small (far) actor updates its pose at the ANIM_LOD rate, and on every update frame its pose is
 *   exactly where an every-frame actor's is (the clips keep their clock); the player's own character, LOD off and a
 *   clip that starts update at once; an actor coming into view on a skipped frame catches up before it is drawn; a
 *   one-shot clip's end (the base clip resumes) comes at most one interval late; skipped frames skip the skin matrices.
 * - Hover highlight: every mesh takes W9 LOOK's exposure-aware overlay (world-render setHighlightOverlay); HEAD's on Classic.
 */
import { Animation, AnimationGroup, ArcRotateCamera, AssetContainer, Color3, MeshBuilder, NullEngine, Quaternion, Scene, Skeleton, TransformNode, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { HIGHLIGHT_COLOR, highlightOverlayCount } from '@sro/world-render'
import { ANIM_LOD, CharacterActor, ModelLibrary, animIntervalMs, animationPool, installPooledInterpolation } from '../src/three/models.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  animationPool.enabled = true
  for (const c of cleanups.splice(0)) c()
})

const FRAME_MS = 16

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useConstantAnimationDeltaTime = true // 16 ms of animation time per frame
  // Looking down +Z from z = -10 (a left-handed scene).
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
  /**
   * A 2 m actor with one joint `J` and a skeleton bone linked to it: STAND1 loops J.x 0 → 3 over 1 s (30 fps),
   * ATTACK1 is a one-shot of 0.5 s. Registered with the library as `character()` does.
   */
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
    const clip = (clipName: string, frames: number, to: number) => {
      const anim = new Animation(`${clipName}_x`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
      anim.setKeys([
        { frame: 0, value: new Vector3(0, 0, 0) },
        { frame: frames, value: new Vector3(to, 0, 0) },
      ])
      const g = new AnimationGroup(clipName, scene)
      g.addTargetedAnimation(anim, joint)
      c.animationGroups.push(g)
    }
    clip('STAND1', 30, 3)
    clip('ATTACK1', 15, 1)
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
  return { scene, camera, library, actor, frame, x }
}

describe('pooled key interpolation (PERF2)', () => {
  it('writes into one scratch value per Animation, with the same values as Babylon; other loop modes allocate', () => {
    installPooledInterpolation()
    const anim = new Animation('a', 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE)
    const a = Quaternion.RotationYawPitchRoll(0.1, 0.2, 0.3)
    const b = Quaternion.RotationYawPitchRoll(1.1, -0.4, 0.2)
    const q1 = anim.quaternionInterpolateFunction(a, b, 0.25)
    const q2 = anim.quaternionInterpolateFunction(a, b, 0.75)
    expect(q1).toBe(q2)
    expect(q2.equalsWithEpsilon(Quaternion.Slerp(a, b, 0.75), 1e-9)).toBe(true)
    const v = new Animation('v', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    const v1 = v.vector3InterpolateFunction(new Vector3(0, 0, 0), new Vector3(2, 4, 6), 0.5)
    expect(v.vector3InterpolateFunction(new Vector3(1, 1, 1), new Vector3(3, 3, 3), 0.5)).toBe(v1)
    expect(v1.asArray()).toEqual([2, 2, 2])
    // Another Animation has its own scratch; a relative loop and the switch off get fresh objects.
    const other = new Animation('o', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    expect(other.vector3InterpolateFunction(Vector3.Zero(), Vector3.One(), 0.5)).not.toBe(v1)
    const rel = new Animation('r', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_RELATIVE)
    expect(rel.vector3InterpolateFunction(Vector3.Zero(), Vector3.One(), 0.5)).not.toBe(rel.vector3InterpolateFunction(Vector3.Zero(), Vector3.One(), 0.5))
    animationPool.enabled = false
    expect(v.vector3InterpolateFunction(Vector3.Zero(), Vector3.One(), 0.5)).not.toBe(v1)
  })

  it('a clip plays the same poses pooled and unpooled', () => {
    const { actor, frame, x } = setup()
    // Two fresh actors, each from its clip's first frame (constant 16 ms steps): same poses frame for frame.
    const run = (name: string) => {
      const a = actor(name, [0, 0, 5])
      a.lodFull = true
      a.play('STAND1')
      const out: number[] = []
      for (let i = 0; i < 40; i++) {
        frame()
        out.push(x(a))
      }
      return out
    }
    const pooled = run('a')
    animationPool.enabled = false
    const raw = run('b')
    expect(raw.length).toBe(pooled.length)
    expect(new Set(pooled).size).toBeGreaterThan(20)
    for (let i = 0; i < raw.length; i++) expect(raw[i]).toBeCloseTo(pooled[i]!, 9)
  })
})

describe('animation LOD (PERF2)', () => {
  it('rates by size on screen and view', () => {
    expect(animIntervalMs(0.5, 3, false)).toBe(0)
    expect(animIntervalMs(ANIM_LOD.fullSize, 15, false)).toBe(0)
    expect(animIntervalMs(0.06, 30, false)).toBeCloseTo(1000 / 30, 9)
    expect(animIntervalMs(0.03, 60, false)).toBeCloseTo(1000 / 20, 9)
    expect(animIntervalMs(0.001, 900, false)).toBeCloseTo(1000 / 10, 9)
    expect(animIntervalMs(0.5, 10, true)).toBeCloseTo(1000 / ANIM_LOD.offscreenNearHz, 9)
    expect(animIntervalMs(0.5, 80, true)).toBeCloseTo(1000 / ANIM_LOD.offscreenHz, 9)
  })

  it('a far actor updates at its rate, always to the pose an every-frame actor has; near and own ones every frame', () => {
    const { actor, frame, x } = setup()
    // 2 m tall at ~60 m: size 0.033, the 20 Hz tier (an update every 3 frames of 16 ms).
    const far = actor('far', [0, 0, 50])
    const ref = actor('ref', [0.5, 0, 50])
    ref.lodFull = true
    const near = actor('near', [0, 0, 2])
    for (const a of [far, ref, near]) a.play('STAND1')
    frame()
    let updates = 0
    let prev = x(far)
    for (let i = 0; i < 30; i++) {
      frame()
      if (!far.lodSkipping) {
        expect(x(far)).toBeCloseTo(x(ref), 9)
        updates++
      } else expect(x(far)).toBe(prev)
      expect(near.lodSkipping).toBe(false)
      expect(ref.lodSkipping).toBe(false)
      prev = x(far)
    }
    expect(updates).toBe(10)
  })

  it('the actor carrying the player (a horse under its rider) updates every frame', () => {
    const { actor, frame } = setup()
    const horse = actor('horse', [0, 0, 50])
    const rider = actor('rider', [0, 0, 0])
    rider.lodFull = true
    horse.play('STAND1')
    rider.attachTo(horse.joint('J')!)
    for (let i = 0; i < 6; i++) {
      frame()
      expect(horse.lodSkipping).toBe(false)
    }
    rider.attachTo(null)
    let skipped = 0
    for (let i = 0; i < 6; i++) {
      frame()
      if (horse.lodSkipping) skipped++
    }
    expect(skipped).toBeGreaterThan(0)
  })

  it('LOD off, and a clip that starts, update on the next frame', () => {
    const { library, actor, frame, x } = setup()
    const far = actor('far', [0, 0, 50])
    far.play('STAND1')
    frame()
    frame()
    frame()
    expect(far.lodSkipping).toBe(true)
    far.playClip('ATTACK1')
    frame()
    expect(far.lodSkipping).toBe(false)
    // W9F CPU-2: a blended clip change updates every frame until the blend is done (Babylon steps the blend per
    // evaluation: blendingSpeed 0.08, 13 evaluations), then the actor is back on its rate.
    let blendFrames = 1
    while (blendFrames < 40) {
      frame()
      if (far.lodSkipping) break
      blendFrames++
    }
    expect(blendFrames).toBeGreaterThanOrEqual(13)
    expect(blendFrames).toBeLessThanOrEqual(16)
    expect(far.lodSkipping).toBe(true)
    library.animLod = false
    const before = x(far)
    frame()
    expect(far.lodSkipping).toBe(false)
    expect(x(far)).not.toBe(before)
  })

  it('an actor that comes into view on a skipped frame shows this frame’s pose', () => {
    const { camera, actor, frame, x } = setup()
    // Behind the camera (off screen: 10 Hz beyond 50 m) and a reference beside it.
    const behind = actor('behind', [0, 0, -80])
    const ref = actor('ref', [0.5, 0, -80])
    ref.lodFull = true
    behind.play('STAND1')
    ref.play('STAND1')
    for (let i = 0; i < 4; i++) frame()
    expect(behind.isOffscreen).toBe(true)
    // Run to a frame the LOD skips, then turn round before the next one.
    let guard = 0
    while (guard++ < 20) {
      frame()
      if (behind.lodSkipping) break
    }
    expect(behind.lodSkipping).toBe(true)
    camera.alpha = Math.PI / 2 // looking down -Z now
    frame()
    expect(behind.isOffscreen).toBe(false)
    expect(x(behind)).toBeCloseTo(x(ref), 9)
  })

  it('a one-shot clip ends at most one interval late, and the base clip resumes', () => {
    const { actor, frame } = setup()
    const far = actor('far', [0, 0, 50])
    const ref = actor('ref', [0.5, 0, 50])
    ref.lodFull = true
    let n = 0
    let endFar = -1
    let endRef = -1
    far.play('STAND1')
    ref.play('STAND1')
    frame()
    far.playAction(far.group('ATTACK1')!)
    ref.playAction(ref.group('ATTACK1')!)
    far.group('ATTACK1')!.onAnimationGroupEndObservable.addOnce(() => (endFar = n))
    ref.group('ATTACK1')!.onAnimationGroupEndObservable.addOnce(() => (endRef = n))
    for (n = 0; n < 60 && (endFar < 0 || endRef < 0); n++) frame()
    expect(endRef).toBeGreaterThan(20)
    expect(endFar - endRef).toBeGreaterThanOrEqual(0)
    expect((endFar - endRef) * FRAME_MS).toBeLessThanOrEqual(1000 / 20)
  })

  it('skipped frames skip the skin matrices', () => {
    const { scene, actor, frame } = setup()
    const far = actor('far', [0, 0, 50])
    far.play('STAND1')
    const skel = far.skeleton!
    const preparedAt = () => (skel as unknown as { _currentRenderId: number })._currentRenderId
    frame()
    let skipped = 0
    for (let i = 0; i < 12; i++) {
      frame()
      // Skeleton.prepare stamps the render id when it runs (the frame's active-mesh pass calls it).
      if (far.lodSkipping) {
        skipped++
        expect(preparedAt()).not.toBe(scene.getRenderId())
      } else expect(preparedAt()).toBe(scene.getRenderId())
    }
    expect(skipped).toBe(8)
  })
})

describe('hover highlight (PERF2 / LOOK)', () => {
  it('every mesh takes the exposure-aware overlay; on Classic (exposure 1) the colour and alpha are HEAD’s', () => {
    const { scene, actor } = setup()
    const a = actor('a', [0, 0, 5])
    const warm = new Color3(1, 0.55, 0.45)
    a.setHighlight(true, warm)
    const meshes = a.allMeshes()
    expect(meshes.length).toBeGreaterThan(0)
    for (const m of meshes) {
      expect(m.renderOverlay).toBe(true)
      expect(m.overlayColor.asArray()).toEqual(warm.asArray())
      expect(m.overlayAlpha).toBeCloseTo(0.28, 9)
    }
    expect(highlightOverlayCount(scene)).toBe(meshes.length)
    a.setHighlight(true)
    expect(meshes[0]!.overlayColor.asArray()).toEqual(HIGHLIGHT_COLOR.asArray())
    a.setHighlight(false)
    for (const m of meshes) expect(m.renderOverlay).toBe(false)
    expect(highlightOverlayCount(scene)).toBe(0)
  })
})
