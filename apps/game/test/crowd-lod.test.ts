/**
 * G1 rescue: the actor side of the crowd budget (three/models.ts).
 * - `setCrowdLod`: the crowd's floor on the pose interval slows a far actor down but never speeds one up; off screen,
 *   'slow' takes the far rate at any distance and 'freeze' stops until the actor is back in view, where it shows this
 *   frame's pose at once (no stale pose: no pop).
 * - `setMergeParts`: the glb's alike skinned parts (same material, skin and layout) draw as one mesh with the same
 *   vertices, formats and triangles; the parts come back unchanged when it is switched off; a re-dress makes it again;
 *   hair, blended materials and parts of other materials stay apart; every per-mesh setting reaches the merged mesh.
 */
import {
  Animation,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  Buffer as BabylonBuffer,
  Constants,
  Matrix,
  Mesh as BabylonMesh,
  MeshBuilder,
  NullEngine,
  Scene,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Mesh,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { ANIM_LOD, CharacterActor, ModelLibrary, mergeSkinnedParts } from '../src/three/models.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const FRAME_MS = 16

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useConstantAnimationDeltaTime = true
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
  camera.minZ = 0.2
  camera.maxZ = 1000
  const library = new ModelLibrary(scene)
  library.animLod = true
  let clock = 0
  library.now = () => clock
  cleanups.push(() => {
    library.dispose()
    scene.dispose()
    engine.dispose()
  })
  const skin = (m: Mesh) => {
    const n = m.getTotalVertices()
    m.setVerticesData(VertexBuffer.MatricesIndicesKind, new Array(n * 4).fill(0), false, 4)
    m.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), false, 4)
  }
  /**
   * A 2 m actor with one joint `J` (a bone linked to it) and skinned parts: `body` and `arms` share material A, `hair`
   * has A too (kept apart by name), `cloak` has its own material B. STAND1 loops J.x 0 → 3 over 1 s.
   */
  const actor = (name: string, at: [number, number, number], o: { blendA?: boolean } = {}) => {
    const root = new TransformNode('__root__', scene)
    const joint = new TransformNode('J', scene)
    joint.parent = root
    const skeleton = new Skeleton(`${name}_skel`, `${name}_skel`, scene)
    const matA = new StandardMaterial(`${name}_A`, scene)
    if (o.blendA) matA.alpha = 0.5
    const matB = new StandardMaterial(`${name}_B`, scene)
    const part = (pn: string, mat: StandardMaterial, y: number) => {
      const m = MeshBuilder.CreateBox(`${name}_${pn}`, { width: 0.5, height: 0.5, depth: 0.5 }, scene)
      m.bakeTransformIntoVertices(Matrix.Translation(0, y, 0))
      skin(m)
      m.material = mat
      m.skeleton = skeleton
      m.parent = root
      return m
    }
    const meshes = [part('body', matA, 1), part('arms', matA, 1.4), part('hair', matA, 1.9), part('cloak', matB, 1.2)]
    const c = new AssetContainer(scene)
    c.transformNodes.push(root, joint)
    c.meshes.push(...meshes)
    c.skeletons.push(skeleton)
    c.materials.push(matA, matB)
    const anim = new Animation('STAND1_x', 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    anim.setKeys([
      { frame: 0, value: new Vector3(0, 0, 0) },
      { frame: 30, value: new Vector3(3, 0, 0) },
    ])
    const g = new AnimationGroup('STAND1', scene)
    g.addTargetedAnimation(anim, joint)
    c.animationGroups.push(g)
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

const updatesOver = (frames: number, a: CharacterActor, frame: () => void) => {
  let n = 0
  for (let i = 0; i < frames; i++) {
    frame()
    if (!a.lodSkipping) n++
  }
  return n
}

describe('setCrowdLod (the crowd budget on an actor)', () => {
  it('a floor slows a far actor down; a floor below its own rate changes nothing; 0 is today', () => {
    const { actor, frame } = setup()
    // 2 m at ~20 m: size 0.1, the 30 Hz tier (an update every 2nd frame of 16 ms).
    const a = actor('a', [0, 0, 10])
    a.play('STAND1')
    for (let i = 0; i < 20; i++) frame() // past the first clip's blend
    const own = updatesOver(60, a, frame)
    expect(own).toBeGreaterThanOrEqual(25)
    expect(own).toBeLessThanOrEqual(31)
    a.setCrowdLod(1000 / 15)
    expect(a.crowdLod).toEqual({ minMs: 1000 / 15, offscreen: 'normal' })
    frame()
    const floored = updatesOver(60, a, frame)
    expect(floored).toBeGreaterThanOrEqual(12)
    expect(floored).toBeLessThanOrEqual(16)
    a.setCrowdLod(5) // faster than its own rate: its own rate stays
    frame()
    expect(Math.abs(updatesOver(60, a, frame) - own)).toBeLessThanOrEqual(2)
    a.setCrowdLod(0)
    expect(a.crowdLod.minMs).toBe(0)
  })

  it('the own character (lodFull) ignores any floor', () => {
    const { actor, frame } = setup()
    const a = actor('a', [0, 0, 30])
    a.lodFull = true
    a.play('STAND1')
    a.setCrowdLod(100, 'freeze')
    expect(updatesOver(30, a, frame)).toBe(30)
  })

  it("off screen: 'slow' takes the far off-screen rate within 50 m; 'freeze' stops, and the pose is current again in view", () => {
    const { camera, actor, frame, x } = setup()
    // Behind the camera at 30 m: ANIM_LOD's near off-screen rate (it may cast into view).
    const a = actor('a', [0, 0, -30])
    const ref = actor('ref', [0.5, 0, -30])
    ref.lodFull = true
    a.play('STAND1')
    ref.play('STAND1')
    for (let i = 0; i < 20; i++) frame()
    expect(a.isOffscreen).toBe(true)
    const near = updatesOver(62, a, frame)
    expect(near).toBeGreaterThanOrEqual(Math.floor((62 * FRAME_MS) / (1000 / ANIM_LOD.offscreenNearHz)) - 1)
    a.setCrowdLod(0, 'slow')
    frame()
    const slow = updatesOver(62, a, frame)
    expect(slow).toBeLessThan(near)
    expect(slow).toBeLessThanOrEqual(Math.ceil((62 * FRAME_MS) / (1000 / ANIM_LOD.offscreenHz)) + 1)
    a.setCrowdLod(0, 'freeze')
    frame()
    const held = x(a)
    expect(updatesOver(40, a, frame)).toBe(0)
    expect(x(a)).toBe(held)
    // Turned round: in view this frame with this frame's pose.
    camera.alpha = Math.PI / 2
    frame()
    expect(a.isOffscreen).toBe(false)
    expect(x(a)).toBeCloseTo(x(ref), 9)
  })
})

describe('setMergeParts (alike parts drawn as one)', () => {
  it('merges the parts that share material and skin into one mesh with their vertices and triangles; hair stays apart', () => {
    const { actor, frame } = setup()
    const a = actor('a', [0, 0, 5])
    a.play('STAND1')
    frame()
    const body = a.meshes.find(m => m.name === 'a_body') as Mesh
    const arms = a.meshes.find(m => m.name === 'a_arms') as Mesh
    const hair = a.meshes.find(m => m.name === 'a_hair') as Mesh
    const cloak = a.meshes.find(m => m.name === 'a_cloak') as Mesh
    const v = a.mergeVersion
    expect(a.setMergeParts(true)).toBe(true)
    expect(a.mergedParts).toBe(true)
    expect(a.mergeVersion).toBeGreaterThan(v)
    const info = a.mergeInfo!
    expect(info.parts).toEqual([body, arms])
    expect(info.meshes).toHaveLength(1)
    const merged = info.meshes[0] as Mesh
    expect(merged.material).toBe(body.material)
    expect(merged.skeleton).toBe(body.skeleton)
    expect(merged.parent).toBe(body.parent)
    expect(merged.getTotalVertices()).toBe(body.getTotalVertices() + arms.getTotalVertices())
    expect(merged.getTotalIndices()).toBe(body.getTotalIndices() + arms.getTotalIndices())
    // The same vertex formats (the same render pipeline), the same positions in order.
    for (const k of body.getVerticesDataKinds()) {
      const src = body.getVertexBuffer(k)!
      const dst = merged.getVertexBuffer(k)!
      expect([dst.type, dst.normalized, dst.byteStride, dst.getSize()]).toEqual([src.type, src.normalized, src.byteStride, src.getSize()])
    }
    const pos = Array.from(merged.getVerticesData(VertexBuffer.PositionKind)!)
    expect(pos).toEqual([...Array.from(body.getVerticesData(VertexBuffer.PositionKind)!), ...Array.from(arms.getVerticesData(VertexBuffer.PositionKind)!)])
    const idx = Array.from(merged.getIndices()!)
    expect(idx.slice(body.getTotalIndices())).toEqual(Array.from(arms.getIndices()!).map(i => i + body.getTotalVertices()))
    // The parts are off, hair and the other material on; the merged mesh is in allMeshes.
    expect(body.isEnabled()).toBe(false)
    expect(arms.isEnabled()).toBe(false)
    expect(hair.isEnabled()).toBe(true)
    expect(cloak.isEnabled()).toBe(true)
    expect(a.allMeshes()).toContain(merged)
    // Per-mesh settings reach it.
    a.setOpacity(0.4)
    expect(merged.visibility).toBe(0.4)
    a.setHighlight(true)
    expect(merged.renderOverlay).toBe(true)
    a.setHighlight(false)
    // Off: the parts as they were, the merged mesh gone.
    expect(a.setMergeParts(false)).toBe(false)
    expect(body.isEnabled()).toBe(true)
    expect(arms.isEnabled()).toBe(true)
    expect(merged.isDisposed()).toBe(true)
    expect(a.mergeInfo).toBeNull()
  })

  it('a blended material is never merged; a single part has nothing to merge with', () => {
    const { actor } = setup()
    const a = actor('b', [0, 0, 5], { blendA: true })
    a.setMergeParts(true)
    expect(a.mergeInfo!.meshes).toHaveLength(0)
    expect(a.meshes.every(m => m.isEnabled())).toBe(true)
  })

  it('mergeSkinnedParts refuses parts whose formats differ', () => {
    const { scene } = setup()
    const p = MeshBuilder.CreateBox('p', { size: 1 }, scene)
    const q = MeshBuilder.CreateBox('q', { size: 1 }, scene)
    q.setVerticesData(VertexBuffer.UVKind, new Array(q.getTotalVertices() * 2).fill(0), false, 2)
    p.setVerticesBuffer(new VertexBuffer(scene.getEngine(), new Uint16Array(p.getTotalVertices() * 2), VertexBuffer.UVKind, { size: 2, type: Constants.UNSIGNED_SHORT, normalized: true }))
    expect(mergeSkinnedParts([p, q])).toBeNull()
  })

  it('mergeSkinnedParts joins interleaved parts (the licensed glbs) and keeps them interleaved', () => {
    const { scene } = setup()
    const engine = scene.getEngine()
    // position (3 floats) + normal (3 floats) in one buffer, stride 24 bytes, as the glTF loader binds an interleaved view
    const part = (name: string, x: number) => {
      const m = new BabylonMesh(name, scene)
      const data = new Float32Array([x, 0, 0, 0, 1, 0, x, 1, 0, 0, 1, 0, x, 0, 1, 0, 1, 0])
      const buf = new BabylonBuffer(engine, new Uint8Array(data.buffer), false, 24, false, false, true)
      m.setVerticesBuffer(new VertexBuffer(engine, buf, VertexBuffer.PositionKind, { stride: 24, offset: 0, size: 3, type: Constants.FLOAT, useBytes: true, takeBufferOwnership: true }))
      m.setVerticesBuffer(new VertexBuffer(engine, buf, VertexBuffer.NormalKind, { stride: 24, offset: 12, size: 3, type: Constants.FLOAT, useBytes: true, takeBufferOwnership: true }))
      m.setIndices([0, 1, 2], 3)
      return m
    }
    const a = part('a', 1)
    const b = part('b', 2)
    const merged = mergeSkinnedParts([a, b])!
    expect(merged).not.toBeNull()
    expect(merged.getTotalVertices()).toBe(6)
    const pos = merged.getVertexBuffer(VertexBuffer.PositionKind)!
    const nor = merged.getVertexBuffer(VertexBuffer.NormalKind)!
    // the parts' layout byte for byte: one shared buffer, the same stride and offsets (the same render pipeline)
    expect(pos.getWrapperBuffer()).toBe(nor.getWrapperBuffer())
    expect([pos.byteStride, pos.byteOffset, nor.byteStride, nor.byteOffset]).toEqual([24, 0, 24, 12])
    expect(Array.from(merged.getVerticesData(VertexBuffer.PositionKind)!)).toEqual([1, 0, 0, 1, 1, 0, 1, 0, 1, 2, 0, 0, 2, 1, 0, 2, 0, 1])
    expect(Array.from(merged.getVerticesData(VertexBuffer.NormalKind)!)).toEqual(new Array(6).fill([0, 1, 0]).flat())
    expect(Array.from(merged.getIndices()!)).toEqual([0, 1, 2, 3, 4, 5])
    // a part laid out otherwise (not interleaved) does not join
    const c = MeshBuilder.CreateBox('c', { size: 1 }, scene)
    c.removeVerticesData(VertexBuffer.UVKind)
    expect(mergeSkinnedParts([a, c])).toBeNull()
    merged.dispose()
  })

  it('a re-dress drops the merge and makes it again from the parts shown now', () => {
    const { actor } = setup()
    const a = actor('c', [0, 0, 5])
    a.setMergeParts(true)
    const first = a.mergeInfo!.meshes[0]!
    a.applyDress({ comp: null, items: [], fallback: null, family: null, gender: 'male', volume: undefined })
    expect(first.isDisposed()).toBe(true)
    expect(a.mergedParts).toBe(true)
    expect(a.mergeInfo!.meshes).toHaveLength(1)
    expect(a.mergeInfo!.meshes[0]).not.toBe(first)
  })
})
