/**
 * Hit reaction on the licensed bodies (CHARACTERS §16): the retail DAMAGE1 flinch is a partial (overlay) clip that keys
 * only Spine1, Neck, Neck1 and Head. Rebuilt for the Epic skeleton it must stay partial: tracks on the target joints of
 * the keyed retail joints only, no hip track, so the overlay wins on the upper spine and head and the base clip (run,
 * attack) keeps the rest of the body. Full clips keep every mapped joint and the hip.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Animation, AnimationGroup, NullEngine, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { buildRetargetSpec, makeRetargeter, type Quat, type RestJoint } from '../src/three/retarget.ts'
import { retargetGroup } from '../src/three/retarget-clips.ts'

const I: Quat = [0, 0, 0, 1]
const retail: RestJoint[] = [
  { name: 'Bip01', parent: null, t: [0, 1, 0], r: I },
  { name: 'Bip01 Pelvis', parent: 'Bip01', t: [0, 0, 0], r: I },
  { name: 'Bip01 Spine', parent: 'Bip01 Pelvis', t: [0, 0.1, 0], r: I },
  { name: 'Bip01 Spine1', parent: 'Bip01 Spine', t: [0, 0.15, 0], r: I },
  { name: 'Bip01 Neck', parent: 'Bip01 Spine1', t: [0, 0.25, 0], r: I },
  { name: 'Bip01 Head', parent: 'Bip01 Neck', t: [0, 0.1, 0], r: I },
  { name: 'Bip01 L Thigh', parent: 'Bip01 Spine', t: [0.09, -0.1, 0], r: I },
  { name: 'Bip01 L Calf', parent: 'Bip01 L Thigh', t: [0, -0.45, 0], r: I },
]
const epic: RestJoint[] = [
  { name: 'root', parent: null, t: [0, 0, 0], r: I },
  { name: 'pelvis', parent: 'root', t: [0, 1, 0], r: I },
  { name: 'spine_02', parent: 'pelvis', t: [0, 0.1, 0], r: I },
  { name: 'spine_03', parent: 'spine_02', t: [0, 0.07, 0], r: I },
  { name: 'spine_04', parent: 'spine_03', t: [0, 0.08, 0], r: I },
  { name: 'neck_01', parent: 'spine_04', t: [0, 0.25, 0], r: I },
  { name: 'head', parent: 'neck_01', t: [0, 0.1, 0], r: I },
  { name: 'thigh_l', parent: 'pelvis', t: [0.09, 0, 0], r: I },
  { name: 'calf_l', parent: 'thigh_l', t: [0, -0.45, 0], r: I },
]
const map = { pelvis: 'Bip01 Pelvis', spine_02: 'Bip01 Spine', spine_04: 'Bip01 Spine1', neck_01: 'Bip01 Neck', head: 'Bip01 Head', thigh_l: 'Bip01 L Thigh', calf_l: 'Bip01 L Calf' }

let engine: NullEngine
let scene: Scene
beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})
afterAll(() => {
  scene.dispose()
  engine.dispose()
})

function nodes(js: readonly RestJoint[], prefix: string): Map<string, TransformNode> {
  const out = new Map<string, TransformNode>()
  for (const j of js) {
    const n = new TransformNode(prefix + j.name, scene)
    n.name = j.name
    n.position.set(...j.t)
    n.rotationQuaternion = new Quaternion(...j.r)
    if (j.parent) n.parent = out.get(j.parent)!
    out.set(j.name, n)
  }
  return out
}

/** A retail clip keying rotations (and translations, as the packs do) on `joints`. */
function clip(name: string, joints: readonly string[], src: Map<string, TransformNode>): AnimationGroup {
  const g = new AnimationGroup(name, scene)
  for (const j of joints) {
    const r = new Animation(`${name}:${j}:r`, 'rotationQuaternion', 30, Animation.ANIMATIONTYPE_QUATERNION)
    r.setKeys([0, 5, 15].map((frame, i) => ({ frame, value: Quaternion.RotationAxis(Vector3.Right(), i === 1 ? -0.4 : 0) })))
    g.addTargetedAnimation(r, src.get(j)!)
    const t = new Animation(`${name}:${j}:t`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3)
    t.setKeys([{ frame: 0, value: src.get(j)!.position.clone() }, { frame: 15, value: src.get(j)!.position.clone() }])
    g.addTargetedAnimation(t, src.get(j)!)
  }
  return g
}

const tracksOf = (g: AnimationGroup) => g.targetedAnimations.map(t => `${(t.target as TransformNode).name}:${t.animation.targetProperty}`).sort()

describe('licensed bodies: partial clips stay partial through the retarget (DAMAGE1 hit flinch)', () => {
  it('keys only the target joints of the keyed retail joints, no hip, whether flagged or detected', () => {
    const rt = makeRetargeter(buildRetargetSpec(retail, epic, { map, aims: {} }))
    const src = nodes(retail, 'r:')
    const dst = nodes(epic, 't:')
    const flinch = clip('benormalhit', ['Bip01 Spine1', 'Bip01 Neck', 'Bip01 Head'], src)
    const want = ['head:rotationQuaternion', 'neck_01:rotationQuaternion', 'spine_04:rotationQuaternion']
    expect(tracksOf(retargetGroup(flinch, 'DAMAGE1', rt, dst, scene, { partial: true }))).toEqual(want)
    // the sidecar flag missing: no key on the hip's joint means partial
    expect(tracksOf(retargetGroup(flinch, 'DAMAGE1b', rt, dst, scene))).toEqual(want)
  })

  it('the flinch bends the spine on the target as on the retail joint', () => {
    const rt = makeRetargeter(buildRetargetSpec(retail, epic, { map, aims: {} }))
    const src = nodes(retail, 'r2:')
    const dst = nodes(epic, 't2:')
    const g = retargetGroup(clip('benormalhit2', ['Bip01 Spine1'], src), 'DAMAGE1', rt, dst, scene, { partial: true })
    const a = g.targetedAnimations.find(t => (t.target as TransformNode).name === 'spine_04')!.animation
    const q = a.evaluate(5) as Quaternion
    // 0.4 rad about X at the key (the parent at rest, so the local is the world change)
    expect(2 * Math.acos(Math.min(1, Math.abs(q.w)))).toBeCloseTo(0.4, 3)
  })

  it('full clips keep every mapped joint and the hip translation', () => {
    const rt = makeRetargeter(buildRetargetSpec(retail, epic, { map, aims: {} }))
    const src = nodes(retail, 'r3:')
    const dst = nodes(epic, 't3:')
    const full = clip('behardhit', ['Bip01', 'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Neck', 'Bip01 Head', 'Bip01 L Thigh', 'Bip01 L Calf'], src)
    const got = tracksOf(retargetGroup(full, 'DAMAGE2', rt, dst, scene))
    expect(got).toContain('pelvis:position')
    for (const j of Object.keys(map)) expect(got).toContain(`${j}:rotationQuaternion`)
  })
})
