import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { AIM_MAX, AIM_SPREAD, UPPER_FADE_S, blendSpeedFor, spreadTurn, turnJoint, upperTurn, upperWeight, wrapAngle, yawBetween } from '../src/three/upper-aim.ts'
import { isUpperJoint } from '../src/three/models.ts'
import { SEATED_CHEST_M, bodyPoint, rootPoint, type AnchorView } from '../src/world/fx/anchors.ts'

const deg = (d: number) => (d * Math.PI) / 180
const yaw = (d: number) => Quaternion.RotationAxis(Vector3.Up(), deg(d))

describe('upper-body aim (mounted and airborne attacks)', () => {
  it('wrapAngle keeps (-π, π]', () => {
    expect(wrapAngle(deg(190))).toBeCloseTo(deg(-170))
    expect(wrapAngle(deg(-190))).toBeCloseTo(deg(170))
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI)
  })

  it('yawBetween reads the turn about up, ignoring a tilt', () => {
    expect(yawBetween(yaw(10), yaw(85))).toBeCloseTo(deg(75))
    expect(yawBetween(yaw(85), yaw(10))).toBeCloseTo(deg(-75))
    // a pitched hip (an archer leaning) keeps its yaw
    const tilt = Quaternion.RotationAxis(Vector3.Right(), deg(20))
    expect(yawBetween(Quaternion.Identity(), yaw(60).multiply(tilt))).toBeCloseTo(deg(60), 1)
  })

  it('upperTurn adds the hip yaw and the aim, clamped to ±100°', () => {
    expect(upperTurn(deg(75), deg(0))).toBeCloseTo(deg(75))
    expect(upperTurn(deg(75), deg(60))).toBeCloseTo(AIM_MAX)
    expect(upperTurn(deg(-75), deg(-90))).toBeCloseTo(-AIM_MAX)
    expect(upperTurn(deg(0), deg(180))).toBeCloseTo(AIM_MAX)
    expect(AIM_MAX).toBeCloseTo(deg(100))
  })

  it('spreadTurn splits over the spine joints and sums to the turn', () => {
    const s = spreadTurn(deg(90), 3)
    expect(s).toHaveLength(3)
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(deg(90))
    expect(s[0]! / deg(90)).toBeCloseTo(AIM_SPREAD[0]!)
    const two = spreadTurn(deg(90), 2)
    expect(two.reduce((a, b) => a + b, 0)).toBeCloseTo(deg(90))
  })

  it('upperWeight fades in, holds, fades out', () => {
    const f = UPPER_FADE_S
    expect(upperWeight(-0.1, 1)).toBe(0)
    expect(upperWeight(0, 1)).toBe(0)
    expect(upperWeight(f / 2, 1)).toBeCloseTo(0.5)
    expect(upperWeight(0.5, 1)).toBe(1)
    expect(upperWeight(1 + f / 2, 1)).toBeCloseTo(0.5)
    expect(upperWeight(1 + f * 2, 1)).toBe(0)
    expect(upperWeight(0.5, 1, 0)).toBe(1)
  })

  it('blendSpeedFor turns seconds into a per-frame blend step', () => {
    expect(blendSpeedFor(0.12, 60)).toBeCloseTo(1 / 7.2)
    expect(blendSpeedFor(0, 60)).toBe(1)
    expect(blendSpeedFor(0.001, 60)).toBe(1)
  })

  it('turnJoint turns the joint about the model up axis whatever its parent orientation', () => {
    const parent = Quaternion.RotationAxis(new Vector3(1, 0.3, 0.2).normalize(), deg(70))
    const local = Quaternion.RotationAxis(Vector3.Forward(), deg(15))
    const out = new Quaternion()
    turnJoint(local, parent, deg(40), out)
    // world after = R(up, 40°) ⊗ world before
    const before = parent.multiply(local)
    const after = parent.multiply(out)
    expect(yawBetween(before, after)).toBeCloseTo(deg(40), 4)
    const expected = yaw(40).multiply(before)
    const dot = Math.abs(Quaternion.Dot(expected, after))
    expect(dot).toBeCloseTo(1, 5)
  })

  it('isUpperJoint: retail Bip01 and licensed (Epic) spine, arms and fingers; never the pelvis or legs', () => {
    for (const n of ['Bip01 Spine', 'Bip01 Spine1', 'Bip01 Neck', 'Bip01 Head', 'Bip01 L UpperArm', 'Bip01 R Finger01',
      'spine_01', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'upperarm_twist_01_r', 'lowerarm_l', 'hand_r', 'index_02_l']) {
      expect([n, isUpperJoint(n)]).toEqual([n, true])
    }
    for (const n of ['Bip01', 'Bip01 Pelvis', 'Bip01 L Thigh', 'Bip01 R Calf', 'pelvis', 'thigh_l', 'calf_r', 'root', undefined]) {
      expect([n, isUpperJoint(n)]).toEqual([n, false])
    }
  })
})

describe('effect anchors on a rider (mounted)', () => {
  const world = (x: number, y: number, z: number) => ({ computeWorldMatrix: () => ({ m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1] }) })
  const view = (seated: boolean) =>
    ({ root: { position: { x: 1, y: 0, z: 2 } }, yaw: 0, height: 2.5, isDisposed: false, scale: 1,
      actor: { attachedTo: seated ? {} : null, root: world(1, 1.4, 2) } }) as unknown as AnchorView

  it('rootPoint and bodyPoint follow the rider up onto the saddle', () => {
    expect(rootPoint(view(false))).toEqual([1, 0, 2])
    expect(rootPoint(view(true))).toEqual([1, 1.4, 2])
    expect(bodyPoint(view(true))[1]).toBeCloseTo(1.4 + SEATED_CHEST_M)
    expect(bodyPoint(view(false))[1]).toBeCloseTo(2.5 * 0.55)
  })
})
