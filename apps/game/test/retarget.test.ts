import { describe, expect, it } from 'vitest'
import { buildRetargetSpec, composeWorld, epicFromBiped, makeRetargeter, offHandIk, qFromTo, qmul, qrot, socketFrame, socketLocal, worldOf, type Quat, type RestJoint, type Vec3 } from '../src/three/retarget.ts'
import { retargetSpecOf } from '../src/three/retarget-clips.ts'
import { isArmJoint } from '../src/three/models.ts'
import { licensedAvailable, licensedChoiceOf, licensedModel, resetLicensedCache } from '../src/three/licensed-char.ts'

const I: Quat = [0, 0, 0, 1]
const axisAngle = (ax: Vec3, a: number): Quat => {
  const s = Math.sin(a / 2), n = Math.hypot(...ax)
  return [(ax[0] / n) * s, (ax[1] / n) * s, (ax[2] / n) * s, Math.cos(a / 2)]
}
const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)))
const dirOf = (w: ReturnType<typeof worldOf>, a: string, b: string): Vec3 => {
  const p = w.get(b)!.p, q = w.get(a)!.p
  const d: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
  const n = Math.hypot(...d)
  return [d[0] / n, d[1] / n, d[2] / n]
}

// A retail biped in its T rest (the left arm along +X; the clavicle on the NECK, the thigh on the SPINE as in the
// retail skeleton) and an Epic body in an A rest (the arm 45° down; clavicle on spine_05, thigh on the pelvis), with
// joint frames that differ from the retail ones (the method must not depend on bone axes).
const retail: RestJoint[] = [
  { name: 'Bip01', parent: null, t: [0, 1, 0], r: axisAngle([0, 1, 0], -Math.PI / 2) },
  { name: 'Bip01 Pelvis', parent: 'Bip01', t: [0, 0, 0], r: axisAngle([1, 0, 0], 0.3) },
  { name: 'Bip01 Spine', parent: 'Bip01 Pelvis', t: [0, 0.1, 0], r: I },
  { name: 'Bip01 Spine1', parent: 'Bip01 Spine', t: [0, 0.15, 0], r: I },
  { name: 'Bip01 Neck', parent: 'Bip01 Spine1', t: [0, 0.25, 0], r: I },
  { name: 'Bip01 L Clavicle', parent: 'Bip01 Neck', t: [0.03, 0, 0], r: axisAngle([0, 0, 1], 0.2) },
  { name: 'Bip01 L UpperArm', parent: 'Bip01 L Clavicle', t: [0.12, 0, 0], r: axisAngle([0, 0, 1], -0.2) },
  { name: 'Bip01 L Forearm', parent: 'Bip01 L UpperArm', t: [0.28, 0, 0], r: I },
  { name: 'Bip01 L Hand', parent: 'Bip01 L Forearm', t: [0.25, 0, 0], r: I },
  { name: 'Bip01 L HandMid', parent: 'Bip01 L Forearm', t: [0.15, 0.03, 0], r: axisAngle([1, 0, 0], 0.5) },
  { name: 'Bip01 L Thigh', parent: 'Bip01 Spine', t: [0.09, -0.1, 0], r: I },
  { name: 'Bip01 L Calf', parent: 'Bip01 L Thigh', t: [0, -0.45, 0], r: I },
]
const down45 = Math.PI / 4
const epic: RestJoint[] = [
  { name: 'root', parent: null, t: [0, 0, 0], r: axisAngle([1, 0, 0], -Math.PI / 2) },
  { name: 'pelvis', parent: 'root', t: [0, 0, 1.05], r: axisAngle([0, 0, 1], 0.7) },
  { name: 'spine_02', parent: 'pelvis', t: [0.1, 0, 0], r: I },
  { name: 'spine_04', parent: 'spine_02', t: [0.15, 0, 0], r: I },
  { name: 'spine_05', parent: 'spine_04', t: [0.1, 0, 0], r: axisAngle([0, 1, 0], 0.1) },
  { name: 'clavicle_l', parent: 'spine_05', t: [0.1, 0.02, 0], r: axisAngle([1, 1, 0], 0.4) },
  { name: 'upperarm_l', parent: 'clavicle_l', t: [0.1, 0, 0], r: axisAngle([0, 1, 1], 0.9) },
  { name: 'lowerarm_l', parent: 'upperarm_l', t: [0.27, 0, 0], r: axisAngle([0, 0, 1], 0.2) },
  { name: 'hand_l', parent: 'lowerarm_l', t: [0.24, 0, 0], r: I },
  { name: 'thigh_l', parent: 'pelvis', t: [0, 0.09, 0], r: axisAngle([0, 1, 0], 0.3) },
  { name: 'calf_l', parent: 'thigh_l', t: [0.43, 0, 0], r: I },
]

/** Re-poses the epic arm so it hangs 45° down in world (the A rest), whatever its bone frames. */
function aPose(js: RestJoint[]): RestJoint[] {
  const out = js.map(j => ({ ...j }))
  const w = worldOf(out)
  const up = out.find(j => j.name === 'upperarm_l')!
  const want: Vec3 = [Math.cos(down45), -Math.sin(down45), 0]
  const turn = qFromTo(dirOf(w, 'upperarm_l', 'lowerarm_l'), want)
  const pq = w.get('clavicle_l')!.q
  const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]
  up.r = qmul(conj(pq), qmul(turn, w.get('upperarm_l')!.q))
  // the forearm straight on along the upper arm
  const w2 = worldOf(out)
  const lo = out.find(j => j.name === 'lowerarm_l')!
  const t2 = qFromTo(dirOf(w2, 'lowerarm_l', 'hand_l'), want)
  lo.r = qmul(conj(w2.get('upperarm_l')!.q), qmul(t2, w2.get('lowerarm_l')!.q))
  return out
}

const map = { pelvis: 'Bip01 Pelvis', spine_02: 'Bip01 Spine', spine_04: 'Bip01 Spine1', clavicle_l: 'Bip01 L Clavicle', upperarm_l: 'Bip01 L UpperArm', lowerarm_l: 'Bip01 L Forearm', hand_l: 'Bip01 L Hand', thigh_l: 'Bip01 L Thigh', calf_l: 'Bip01 L Calf' }
const aims = {
  upperarm_l: { aim: 'lowerarm_l', retail: 'Bip01 L UpperArm', retailAim: 'Bip01 L Forearm' },
  lowerarm_l: { aim: 'hand_l', retail: 'Bip01 L Forearm', retailAim: 'Bip01 L Hand' },
  thigh_l: { aim: 'calf_l', retail: 'Bip01 L Thigh', retailAim: 'Bip01 L Calf' },
}

describe('retarget: retail biped clips on an Epic skeleton (CHARACTERS §16)', () => {
  const epicA = aPose(epic)
  const spec = buildRetargetSpec(retail, epicA, { map, aims })
  const rt = makeRetargeter(spec)

  it('maps every body role of the biped onto the Epic joints', () => {
    const m = epicFromBiped()
    for (const [e, b] of [['pelvis', 'Bip01 Pelvis'], ['head', 'Bip01 Head'], ['neck_01', 'Bip01 Neck'], ['spine_02', 'Bip01 Spine'], ['spine_04', 'Bip01 Spine1'], ['clavicle_r', 'Bip01 R Clavicle'], ['upperarm_l', 'Bip01 L UpperArm'], ['lowerarm_r', 'Bip01 R Forearm'], ['hand_l', 'Bip01 L Hand'], ['thigh_r', 'Bip01 R Thigh'], ['calf_l', 'Bip01 L Calf'], ['foot_r', 'Bip01 R Foot'], ['ball_l', 'Bip01 L Toe0'], ['index_01_r', 'Bip01 R Finger1'], ['thumb_01_l', 'Bip01 L Finger0'], ['pinky_02_r', 'Bip01 R Finger21']]) expect(m[e!]).toBe(b)
    // no twist, IK or extra (hair/cloth) bone is driven
    expect(Object.keys(m).some(k => /twist|ik_|hair|breast/.test(k))).toBe(false)
  })

  it('corrects the A-pose rest to the retail T rest, and the retail rest gives that rest back', () => {
    const w = worldOf(spec.target)
    close(dirOf(w, 'upperarm_l', 'lowerarm_l'), dirOf(worldOf(retail), 'Bip01 L UpperArm', 'Bip01 L Forearm'))
    const p = rt.pose(() => undefined)
    for (const j of spec.target) if (p.rot.has(j.name)) close(p.rot.get(j.name)!.map(Math.abs), j.r.map(Math.abs))
    // the hip at rest stays where the body has it
    close(p.hip, spec.target.find(j => j.name === 'pelvis')!.t)
  })

  it('transfers world rotations across different hierarchies and bone frames (arm down, knee bent)', () => {
    // the retail clip drops the upper arm 80° and bends the knee 60° (local keys on the retail joints)
    const keys: Record<string, Quat> = {
      'Bip01 L UpperArm': qmul(retail[6]!.r, axisAngle([0, 0, 1], -80 * Math.PI / 180)),
      'Bip01 L Thigh': qmul(retail[10]!.r, axisAngle([1, 0, 0], 0.4)),
      'Bip01 L Calf': axisAngle([1, 0, 0], -60 * Math.PI / 180),
      'Bip01 Spine1': axisAngle([0, 0, 1], 0.25),
    }
    const p = rt.pose(n => (keys[n] ? { r: keys[n] } : undefined))
    const rW = worldOf(retail, j => (keys[j.name] ? { r: keys[j.name] } : undefined))
    const tW = worldOf(spec.target, j => (p.rot.has(j.name) ? { r: p.rot.get(j.name) } : undefined))
    // every mapped bone points where the retail bone points, the spine bend on the neck-hung clavicle included
    close(dirOf(tW, 'upperarm_l', 'lowerarm_l'), dirOf(rW, 'Bip01 L UpperArm', 'Bip01 L Forearm'), 1e-5)
    close(dirOf(tW, 'thigh_l', 'calf_l'), dirOf(rW, 'Bip01 L Thigh', 'Bip01 L Calf'), 1e-5)
    // the world rotation change of each mapped joint is the retail one
    for (const [t, r] of Object.entries(map)) {
      const dT = qmul(tW.get(t)!.q, [-worldOf(spec.target).get(t)!.q[0], -worldOf(spec.target).get(t)!.q[1], -worldOf(spec.target).get(t)!.q[2], worldOf(spec.target).get(t)!.q[3]])
      const dR = qmul(rW.get(r)!.q, [-worldOf(retail).get(r)!.q[0], -worldOf(retail).get(r)!.q[1], -worldOf(retail).get(r)!.q[2], worldOf(retail).get(r)!.q[3]])
      const v: Vec3 = [0.3, 0.5, 0.7]
      close(qrot(dT, v), qrot(dR, v), 1e-5)
    }
  })

  it('keys rotations only: the hip path scaled by the hip heights, nothing else translates', () => {
    expect(spec.hip.scale).toBeCloseTo(1.05 / 1, 6)
    const p = rt.pose(n => (n === 'Bip01' ? { r: retail[0]!.r, t: [0.2, 0.9, 0] } : undefined))
    // the retail pelvis moved (+0.2, −0.1) in model space → the Epic pelvis by 1.05 × that, in its parent's frame
    const parentQ = worldOf(spec.target).get('root')!.q
    const world = qrot(parentQ, p.hip)
    close(world, [0.2 * 1.05, 1.05 - 0.1 * 1.05, 0], 1e-6)
    expect([...p.rot.keys()].every(k => k in map)).toBe(true)
  })

  it('gives every retail joint a socket stand-in that turns with its joint (weapon in hand)', () => {
    const s = spec.sockets['Bip01 L HandMid']!
    expect(s.parent).toBe('lowerarm_l')
    const keys: Record<string, Quat> = { 'Bip01 L Forearm': axisAngle([0, 1, 0], 0.7), 'Bip01 L UpperArm': qmul(retail[6]!.r, axisAngle([0, 0, 1], -1)) }
    const p = rt.pose(n => (keys[n] ? { r: keys[n] } : undefined))
    const tW = worldOf(spec.target, j => (p.rot.has(j.name) ? { r: p.rot.get(j.name) } : undefined))
    const rW = worldOf(retail, j => (keys[j.name] ? { r: keys[j.name] } : undefined))
    // socket world = parent world × alias local; the item turns by (socket world × bind⁻¹) as on the retail joint
    const sockQ = qmul(tW.get('lowerarm_l')!.q, s.r)
    const itemT = qmul(sockQ, [-s.bind[0], -s.bind[1], -s.bind[2], s.bind[3]])
    const rb = worldOf(retail).get('Bip01 L HandMid')!.q
    const itemR = qmul(rW.get('Bip01 L HandMid')!.q, [-rb[0], -rb[1], -rb[2], rb[3]])
    close(qrot(itemT, [1, 0, 0]), qrot(itemR, [1, 0, 0]), 1e-5)
    close(qrot(itemT, [0, 1, 0]), qrot(itemR, [0, 1, 0]), 1e-5)
  })

  it("moves a socket stand-in with its retail joint's own keys (the polearm sliding through the hand, §16.8)", () => {
    const f = socketFrame(rt, 'Bip01 L HandMid')!
    expect(f.anchorR).toBe('Bip01 L Forearm')
    expect(f.anchorT).toBe('lowerarm_l')
    const rest = retail.find(j => j.name === 'Bip01 L HandMid')!
    // at rest the animated stand-in is the spec's static alias
    const l = socketLocal(f.c, { p: rest.t, q: rest.r })
    close(l.p, spec.sockets['Bip01 L HandMid']!.t)
    close(l.q, spec.sockets['Bip01 L HandMid']!.r)
    // a key that slides the joint 0.2 along its parent's −Y moves the stand-in by the same 0.2 in the target's frame
    const slid = socketLocal(f.c, { p: [rest.t[0], rest.t[1] - 0.2, rest.t[2]], q: rest.r })
    expect(Math.hypot(slid.p[0] - l.p[0], slid.p[1] - l.p[1], slid.p[2] - l.p[2])).toBeCloseTo(0.2, 6)
  })

  it("puts the off hand back on a two-handed weapon by IK: the retail hand's offset from the socket, its rotation kept", () => {
    const keys: Record<string, Quat> = { 'Bip01 L UpperArm': qmul(retail[6]!.r, axisAngle([0, 0, 1], -0.9)), 'Bip01 L Forearm': axisAngle([0, 1, 0], 0.8) }
    const pose = rt.pose(n => (keys[n] ? { r: keys[n] } : undefined))
    const handQ = pose.targetWorld.get('hand_l')!.q
    const main = 'Bip01 L Forearm'
    const f = socketFrame(rt, main)!
    const rel = { p: [0, 0, 0] as Vec3, q: I }
    // the socket where the clip puts it (the IK moves the anchor's arm afterwards, not the goal)
    const sR = composeWorld(pose.retailWorld.get(f.anchorR)!, rel)
    const sT = composeWorld(pose.targetWorld.get(f.anchorT)!, socketLocal(f.c, rel))
    expect(offHandIk(rt, pose, main, rel, 'l')).toBe(true)
    const hR = pose.retailWorld.get('Bip01 L Hand')!.p
    const want = [0, 1, 2].map(i => sT.p[i]! + (hR[i]! - sR.p[i]!))
    // the solved locals, run through FK, land the hand on the goal with its world rotation unchanged
    const tW = worldOf(spec.target, j => (pose.rot.has(j.name) ? { r: pose.rot.get(j.name) } : undefined))

    close(tW.get('hand_l')!.p, want, 1e-4)
    close(tW.get('hand_l')!.q.map(Math.abs), handQ.map(Math.abs), 1e-5)
    // bone lengths kept
    const len = (w: typeof tW, a: string, b: string) => Math.hypot(...[0, 1, 2].map(i => w.get(b)!.p[i]! - w.get(a)!.p[i]!))
    expect(len(tW, 'upperarm_l', 'lowerarm_l')).toBeCloseTo(len(worldOf(spec.target), 'upperarm_l', 'lowerarm_l'), 6)
  })

  it('finds the arm joints of the Epic skeleton for the weapon arm layer', () => {
    expect(isArmJoint('upperarm_twist_01_r', ['R'])).toBe(true)
    expect(isArmJoint('index_02_l', ['R'])).toBe(false)
    expect(isArmJoint('clavicle_l', ['L'])).toBe(true)
    expect(isArmJoint('thigh_l', ['L', 'R'])).toBe(false)
    expect(isArmJoint('Bip01 R Hand', ['R'])).toBe(true)
  })
})

describe('licensed body flag and the absent-files fallback (CHARACTERS §16)', () => {
  it('reads newchar=1 by gender and the outfit variant', () => {
    expect(licensedChoiceOf('', 'female')).toBeNull()
    expect(licensedChoiceOf('?newchar=average', 'female')).toBeNull() // the pilot presets stay the pilot's
    expect(licensedChoiceOf('?newchar=1', 'female')).toEqual({ gender: 'f', outfit: '01' })
    expect(licensedChoiceOf('?newchar=1&ncoutfit=04', 'female')).toEqual({ gender: 'f', outfit: '04' })
    expect(licensedChoiceOf('?newchar=1&ncoutfit=4', 'male')).toEqual({ gender: 'm', outfit: '01' }) // the boy has 01..03
    expect(licensedChoiceOf('?newchar=1&ncoutfit=3', 'male')).toEqual({ gender: 'm', outfit: '03' })
    expect(licensedModel({ gender: 'm', outfit: '02' }).glb).toBe('/out/char/licensed/waterbender/waterbender_m_02.glb')
  })

  it('is unavailable when the files are not served (404, an HTML fallback page, a network error, no spec)', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => new Response('nope', { status: 404 }),
      async () => new Response('<!doctype html><html></html>', { status: 200 }),
      async () => { throw new Error('offline') },
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    ]
    for (const c of cases) {
      resetLicensedCache()
      expect(await licensedAvailable({ gender: 'f', outfit: '01' }, c as typeof fetch)).toBe(false)
    }
    resetLicensedCache()
    expect(await licensedAvailable({ gender: 'f', outfit: '01' }, (async () => new Response(JSON.stringify({ retarget: { version: 1 } }))) as typeof fetch)).toBe(true)
    resetLicensedCache()
  })

  it('treats ordinary sidecars as no retarget (the existing bodies play their clips by name)', () => {
    expect(retargetSpecOf(null)).toBeNull()
    expect(retargetSpecOf({ animations: [] })).toBeNull()
    expect(retargetSpecOf({ retarget: { version: 2 } })).toBeNull()
  })
})
