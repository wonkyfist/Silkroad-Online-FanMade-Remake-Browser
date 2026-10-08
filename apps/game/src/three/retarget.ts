// Licensed characters (docs/CHARACTERS.md §16): the retail Silkroad clips (3ds Max biped `Bip01 …` skeleton) played on a
// body with its OWN skeleton (the Waterbender's Epic/UE5 rig), untouched: no joint is moved, no weight changed.
// Dependency-free so the converter (packages/convert/src/tools/licensed-char.ts) builds the spec with the same code the
// game plays it with, and the tests run it without Babylon.
//
// Method (rotations only, the lessons of §15): every mapped target joint takes the WORLD rotation change of its retail
// joint from the retail rest, applied on top of the target's rest *aligned to the retail rest pose* (the A-pose arms,
// legs, hands and fingers turned onto the retail T-pose directions, so a clip's "arm down" is down on both):
//   W_target(t) = D_retail(t) · W'_target_rest,   D_retail(t) = W_retail(t) · W_retail_rest⁻¹
// and the target's local key is W_parent(t)⁻¹ · W_target(t) (the parents are posed the same way first; unmapped target
// joints keep their rest local). World-space transfer works across the two hierarchies (the biped hangs the clavicles
// on the neck and the thighs on the spine; Epic on spine_05 and the pelvis). No per-joint translation and no scale is
// ever keyed; the hip translation is the retail pelvis path scaled by the hip heights.

export type Quat = [number, number, number, number] // x, y, z, w (glTF order)
export type Vec3 = [number, number, number]

/** A joint's rest, local to its parent (glTF node TRS, parents listed first). */
export interface RestJoint {
  name: string
  parent: string | null
  t: Vec3
  r: Quat
}

/** A retail joint's stand-in on the target body (weapon sockets, effect joints): a node under `parent`. */
export interface SocketAlias {
  /** The target joint it hangs under. */
  parent: string
  t: Vec3
  r: Quat
  /** The retail joint's world rest rotation (the socket rule cancels it: the item turns with the joint's change). */
  bind: Quat
}

export interface RetargetSpec {
  version: 1
  /** The retail joints the transfer reads (mapped ones and their ancestors), parents first, rest locals. */
  retail: RestJoint[]
  /** The target joints it poses (mapped ones and their ancestors), parents first; `r` is the ALIGNED rest local. */
  target: RestJoint[]
  /** Target joint → retail joint (several target joints may follow one retail joint: ring/pinky follow Finger2). */
  map: Record<string, string>
  /** Hip translation: the target joint that carries it, the retail joint whose path it follows, the height ratio. */
  hip: { target: string; retail: string; scale: number }
  /** Retail joint name → its stand-in on the target (every retail joint, so sockets and effects keep their names). */
  sockets: Record<string, SocketAlias>
  /** Ground clamp (CharacterActor.enableGroundClamp): the joint lifted, up in its parent's frame, the probes. */
  clamp: { root: string; up: Vec3; probes: [string, number][] }
}

// --- quaternion / vector math --------------------------------------------------------------------------------------

export function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}
export const qinv = (q: Quat): Quat => {
  const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1
  return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n]
}
export function qnorm(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}
export function qrot(q: Quat, v: Vec3): Vec3 {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), qinv(q))
  return [p[0], p[1], p[2]]
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1))

/** The shortest rotation taking direction `a` onto direction `b`. */
export function qFromTo(a: Vec3, b: Vec3): Quat {
  const u = unit(a), v = unit(b)
  const d = dot(u, v)
  if (d < -0.999999) {
    // opposite: any axis perpendicular to u
    const ax = unit(Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]))
    return [ax[0], ax[1], ax[2], 0]
  }
  const c = cross(u, v)
  return qnorm([c[0], c[1], c[2], 1 + d])
}

/** Keeps `q` in the hemisphere of `ref` (q and −q are the same rotation; keys must not flip between frames). */
export function qalign(q: Quat, ref: Quat): Quat {
  return q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q
}

// --- skeletons -------------------------------------------------------------------------------------------------------

export interface World {
  p: Vec3
  q: Quat
}

/** World (model-space) transforms of a joint list (parents first), with optional local overrides. */
export function worldOf(joints: readonly RestJoint[], local?: (j: RestJoint) => { t?: Vec3; r?: Quat } | undefined): Map<string, World> {
  const out = new Map<string, World>()
  for (const j of joints) {
    const o = local?.(j)
    const t = o?.t ?? j.t, r = o?.r ?? j.r
    const p = j.parent ? out.get(j.parent) : undefined
    out.set(j.name, p ? { p: add(p.p, qrot(p.q, t)), q: qnorm(qmul(p.q, r)) } : { p: t, q: qnorm(r) })
  }
  return out
}

/** The joints in `all` that `names` need (themselves and every ancestor), parents first. */
export function chainOf(all: readonly RestJoint[], names: Iterable<string>): RestJoint[] {
  const by = new Map(all.map(j => [j.name, j]))
  const keep = new Set<string>()
  for (const n of names) for (let j = by.get(n); j && !keep.has(j.name); j = j.parent ? by.get(j.parent) : undefined) keep.add(j.name)
  return all.filter(j => keep.has(j.name))
}

/** Sorts a joint list parents first (stable otherwise). */
export function parentsFirst(joints: readonly RestJoint[]): RestJoint[] {
  const by = new Map(joints.map(j => [j.name, j]))
  const out: RestJoint[] = []
  const seen = new Set<string>()
  const visit = (j: RestJoint) => {
    if (seen.has(j.name)) return
    seen.add(j.name)
    if (j.parent && by.has(j.parent)) visit(by.get(j.parent)!)
    out.push(j)
  }
  joints.forEach(visit)
  return out
}

// --- the biped → Epic role map ---------------------------------------------------------------------------------------

const SIDES = [['l', 'L'], ['r', 'R']] as const

/** Target (Epic UE5) joint → retail biped joint, by role. Fingers: the biped has thumb, index and one "rest" finger. */
export function epicFromBiped(): Record<string, string> {
  const m: Record<string, string> = {
    pelvis: 'Bip01 Pelvis',
    spine_02: 'Bip01 Spine',
    spine_04: 'Bip01 Spine1',
    neck_01: 'Bip01 Neck',
    neck_02: 'Bip01 Neck1',
    head: 'Bip01 Head',
  }
  for (const [e, b] of SIDES) {
    Object.assign(m, {
      [`clavicle_${e}`]: `Bip01 ${b} Clavicle`,
      [`upperarm_${e}`]: `Bip01 ${b} UpperArm`,
      [`lowerarm_${e}`]: `Bip01 ${b} Forearm`,
      [`hand_${e}`]: `Bip01 ${b} Hand`,
      [`thumb_01_${e}`]: `Bip01 ${b} Finger0`,
      [`thumb_02_${e}`]: `Bip01 ${b} Finger01`,
      [`index_01_${e}`]: `Bip01 ${b} Finger1`,
      [`index_02_${e}`]: `Bip01 ${b} Finger11`,
      [`middle_01_${e}`]: `Bip01 ${b} Finger2`,
      [`middle_02_${e}`]: `Bip01 ${b} Finger21`,
      [`ring_01_${e}`]: `Bip01 ${b} Finger2`,
      [`ring_02_${e}`]: `Bip01 ${b} Finger21`,
      [`pinky_01_${e}`]: `Bip01 ${b} Finger2`,
      [`pinky_02_${e}`]: `Bip01 ${b} Finger21`,
      [`thigh_${e}`]: `Bip01 ${b} Thigh`,
      [`calf_${e}`]: `Bip01 ${b} Calf`,
      [`foot_${e}`]: `Bip01 ${b} Foot`,
      [`ball_${e}`]: `Bip01 ${b} Toe0`,
    })
  }
  return m
}

/**
 * The rest-pose alignment (A-pose → the retail T-pose): target joint → [its aim child, the retail joint, its aim child],
 * plus for the hands a second axis (index → pinky across the palm vs Finger1 → Finger2) so the palm turns with the arm.
 * Spine, neck, head and clavicles are not aligned (the body keeps its own posture and shoulders).
 */
export function epicAims(): Record<string, { aim: string; retail: string; retailAim: string; side?: [string, string, string, string] }> {
  const a: ReturnType<typeof epicAims> = {}
  for (const [e, b] of SIDES) {
    const B = (s: string) => `Bip01 ${b} ${s}`
    a[`upperarm_${e}`] = { aim: `lowerarm_${e}`, retail: B('UpperArm'), retailAim: B('Forearm') }
    a[`lowerarm_${e}`] = { aim: `hand_${e}`, retail: B('Forearm'), retailAim: B('Hand') }
    a[`hand_${e}`] = { aim: `middle_01_${e}`, retail: B('Hand'), retailAim: B('Finger2'), side: [`index_01_${e}`, `pinky_01_${e}`, B('Finger1'), B('Finger2')] }
    a[`thumb_01_${e}`] = { aim: `thumb_02_${e}`, retail: B('Finger0'), retailAim: B('Finger01') }
    a[`index_01_${e}`] = { aim: `index_02_${e}`, retail: B('Finger1'), retailAim: B('Finger11') }
    a[`middle_01_${e}`] = { aim: `middle_02_${e}`, retail: B('Finger2'), retailAim: B('Finger21') }
    a[`ring_01_${e}`] = { aim: `ring_02_${e}`, retail: B('Finger2'), retailAim: B('Finger21') }
    a[`pinky_01_${e}`] = { aim: `pinky_02_${e}`, retail: B('Finger2'), retailAim: B('Finger21') }
    a[`thigh_${e}`] = { aim: `calf_${e}`, retail: B('Thigh'), retailAim: B('Calf') }
    a[`calf_${e}`] = { aim: `foot_${e}`, retail: B('Calf'), retailAim: B('Foot') }
    a[`foot_${e}`] = { aim: `ball_${e}`, retail: B('Foot'), retailAim: B('Toe0') }
  }
  return a
}

/** Ground-clamp probes on the Epic legs (joint, clearance above the skin that touches the ground, m). */
export const EPIC_CLAMP_PROBES: [string, number][] = [
  ['calf_l', 0.045], ['calf_r', 0.045], ['foot_l', 0.06], ['foot_r', 0.06], ['ball_l', 0.012], ['ball_r', 0.012],
]

// --- building the spec (converter) -------------------------------------------------------------------------------

/**
 * Builds the spec from the two rests (glTF model space, the same frame: Y up, facing +Z, metres). `map` / `aims`
 * default to the biped → Epic roles; target joints the body lacks are dropped from them.
 */
export function buildRetargetSpec(
  retailAll: readonly RestJoint[],
  targetAll: readonly RestJoint[],
  opts: { map?: Record<string, string>; aims?: ReturnType<typeof epicAims>; hip?: [string, string] } = {},
): RetargetSpec {
  const retailNames = new Set(retailAll.map(j => j.name))
  const targetNames = new Set(targetAll.map(j => j.name))
  const map = Object.fromEntries(Object.entries(opts.map ?? epicFromBiped()).filter(([t, r]) => targetNames.has(t) && retailNames.has(r)))
  const aims = Object.fromEntries(Object.entries(opts.aims ?? epicAims()).filter(([t, a]) => map[t] && targetNames.has(a.aim) && retailNames.has(a.retail) && retailNames.has(a.retailAim)))
  const [hipT, hipR] = opts.hip ?? ['pelvis', 'Bip01 Pelvis']
  if (!map[hipT]) throw new Error(`retarget: hip joint ${hipT} not mapped`)
  const rWorld = worldOf(parentsFirst(retailAll))
  const tSorted = parentsFirst(targetAll)

  // the aligned rest: top-down, each aimed joint turned (in world) so its bone points along the retail bone
  const aligned = new Map(tSorted.map(j => [j.name, { ...j }]))
  const alignedList = () => tSorted.map(j => aligned.get(j.name)!)
  for (const j of tSorted) {
    const aim = aims[j.name]
    if (!aim) continue
    const w = worldOf(alignedList())
    const me = w.get(j.name)!
    let turn = qFromTo(sub(w.get(aim.aim)!.p, me.p), sub(rWorld.get(aim.retailAim)!.p, rWorld.get(aim.retail)!.p))
    if (aim.side && targetNames.has(aim.side[0]) && targetNames.has(aim.side[1])) {
      // the twist about the (now aligned) bone: the palm's across-axis onto the retail one, both projected off the bone
      const bone = unit(sub(rWorld.get(aim.retailAim)!.p, rWorld.get(aim.retail)!.p))
      const off = (v: Vec3) => unit(sub(v, scale(bone, dot(v, bone))))
      const tSide = off(qrot(turn, sub(w.get(aim.side[1])!.p, w.get(aim.side[0])!.p)))
      const rSide = off(sub(rWorld.get(aim.side[3])!.p, rWorld.get(aim.side[2])!.p))
      turn = qmul(qFromTo(tSide, rSide), turn)
    }
    const parentQ = j.parent ? w.get(j.parent)!.q : ([0, 0, 0, 1] as Quat)
    const newWorld = qnorm(qmul(turn, me.q))
    aligned.get(j.name)!.r = qnorm(qmul(qinv(parentQ), newWorld))
  }

  const target = chainOf(alignedList(), Object.keys(map))
  const retail = chainOf(parentsFirst(retailAll), new Set(Object.values(map)))
  const tWorld = worldOf(alignedList())
  const hipScale = tWorld.get(hipT)!.p[1] / rWorld.get(hipR)!.p[1]

  // a stand-in for every retail joint, under the target joint of its nearest mapped ancestor (or itself)
  const reverse = new Map<string, string>()
  for (const [t, r] of Object.entries(map)) if (!reverse.has(r)) reverse.set(r, t)
  const rBy = new Map(retailAll.map(j => [j.name, j]))
  const sockets: Record<string, SocketAlias> = {}
  for (const j of retailAll) {
    let anchor: RestJoint | undefined = j
    while (anchor && !reverse.has(anchor.name)) anchor = anchor.parent ? rBy.get(anchor.parent) : undefined
    if (!anchor) continue
    const tj = reverse.get(anchor.name)!
    const tw = tWorld.get(tj)!, rw = rWorld.get(j.name)!, ra = rWorld.get(anchor.name)!
    const inv = qinv(tw.q)
    sockets[j.name] = { parent: tj, t: qrot(inv, sub(rw.p, ra.p)), r: qnorm(qmul(inv, rw.q)), bind: rw.q }
  }
  const hipParent = targetAll.find(j => j.name === hipT)!.parent
  const up: Vec3 = hipParent ? unit(qrot(qinv(tWorld.get(hipParent)!.q), [0, 1, 0])) : [0, 1, 0]
  return {
    version: 1,
    retail,
    target,
    map,
    hip: { target: hipT, retail: hipR, scale: Math.round(hipScale * 1e4) / 1e4 },
    sockets,
    clamp: { root: hipT, up, probes: EPIC_CLAMP_PROBES.filter(([n]) => targetNames.has(n)) },
  }
}

// --- playing (game) ------------------------------------------------------------------------------------------------

/** One retargeted frame: target local rotations, the hip's local translation, and both skeletons' worlds (model space). */
export interface RetargetPose {
  rot: Map<string, Quat>
  hip: Vec3
  retailWorld: Map<string, World>
  targetWorld: Map<string, World>
}

/** The prepared, per-actor form of a spec (worlds of the rests computed once). */
export interface Retargeter {
  spec: RetargetSpec
  /** Retail joints whose local rotation a frame needs (mapped ones and their ancestors). */
  retailJoints: readonly string[]
  /** The rests' worlds (retail; target aligned). */
  retailRest: ReadonlyMap<string, World>
  targetRest: ReadonlyMap<string, World>
  /** One frame: the retail locals (rotations; the hip joint's ancestors' translations) → target local rotations
   *  for every mapped joint and the hip joint's local translation. Missing retail joints keep their rest. */
  pose(retail: (name: string) => { r?: Quat; t?: Vec3 } | undefined): RetargetPose
}

/** a ∘ b (b given in a's frame). */
export function composeWorld(a: World, b: World): World {
  return { p: add(a.p, qrot(a.q, b.p)), q: qnorm(qmul(a.q, b.q)) }
}

/**
 * Where a retail joint's stand-in hangs (CHARACTERS §16.8): its nearest mapped retail ancestor (or itself) `anchorR`,
 * the target joint of that anchor `anchorT`, and the fixed turn `c` = T_rest(anchorT)⁻¹ · R_rest(anchorR): the stand-in's
 * local transform under `anchorT` is `c` applied to the retail joint's transform relative to `anchorR` (at rest that is
 * the spec's static alias; in a clip it follows the retail joint's own keys, e.g. a polearm sliding through the hand).
 */
export function socketFrame(rt: Retargeter, retailJoint: string): { anchorR: string; anchorT: string; c: Quat } | null {
  const alias = rt.spec.sockets[retailJoint]
  if (!alias) return null
  const anchorR = rt.spec.map[alias.parent]
  const tr = rt.targetRest.get(alias.parent), rr = anchorR ? rt.retailRest.get(anchorR) : undefined
  if (!anchorR || !tr || !rr) return null
  return { anchorR, anchorT: alias.parent, c: qnorm(qmul(qinv(tr.q), rr.q)) }
}

/** The stand-in's local transform for `rel` (the retail joint relative to its anchor; see socketFrame). */
export function socketLocal(c: Quat, rel: World): World {
  return { p: qrot(c, rel.p), q: qnorm(qmul(c, rel.q)) }
}

/**
 * Two-handed weapons on a body with other proportions (CHARACTERS §16.8): rotations alone put each hand where the
 * retail hand is turned, not where it is, so the off hand misses the shaft (the retail arms are other lengths). This
 * moves the off hand (`off` side: upper arm, forearm, hand) with a two-bone IK to the retail hand's offset from the
 * weapon's socket (`main`, a retail joint; `mainRel` its transform relative to its anchor this frame), the elbow kept
 * in its plane and the hand's world rotation kept. Edits `pose.rot` / `pose.targetWorld` in place; false if the chain
 * is missing.
 */
export function offHandIk(rt: Retargeter, pose: RetargetPose, main: string, mainRel: World, off: 'l' | 'r'): boolean {
  const f = socketFrame(rt, main)
  const [u, l, h] = [`upperarm_${off}`, `lowerarm_${off}`, `hand_${off}`]
  const handR = rt.spec.map[h]
  const tW = pose.targetWorld, rW = pose.retailWorld
  const U = tW.get(u), L = tW.get(l), H = tW.get(h), aT = f && tW.get(f.anchorT), aR = f && rW.get(f.anchorR), hR = handR && rW.get(handR)
  const uj = rt.spec.target.find(j => j.name === u)
  if (!f || !U || !L || !H || !aT || !aR || !hR || !uj) return false
  const sR = composeWorld(aR, mainRel)
  const sT = composeWorld(aT, socketLocal(f.c, mainRel))
  // the off hand's world offset from the socket is the retail one (the socket turns as the retail socket does)
  const goal = add(sT.p, qrot(sT.q, qrot(qinv(sR.q), sub(hR.p, sR.p))))
  const a = Math.hypot(...sub(L.p, U.p)), b = Math.hypot(...sub(H.p, L.p))
  const toGoal = sub(goal, U.p)
  const d = Math.min(Math.max(Math.hypot(...toGoal), Math.abs(a - b) + 1e-4), (a + b) * 0.9995)
  const n = unit(toGoal)
  const e0 = sub(L.p, U.p)
  let pole = sub(e0, scale(n, dot(e0, n)))
  if (Math.hypot(...pole) < 1e-6) pole = sub(qrot(U.q, [0, 0, 1]), scale(n, dot(qrot(U.q, [0, 0, 1]), n)))
  pole = unit(pole)
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)))
  const elbow = add(U.p, add(scale(n, a * cosA), scale(pole, a * Math.sqrt(1 - cosA * cosA))))
  const hand = add(U.p, scale(n, d))
  const t1 = qFromTo(e0, sub(elbow, U.p))
  const uq = qnorm(qmul(t1, U.q))
  const lq0 = qnorm(qmul(t1, L.q))
  const t2 = qFromTo(qrot(t1, sub(H.p, L.p)), sub(hand, elbow))
  const lq = qnorm(qmul(t2, lq0))
  const parentQ = uj.parent ? tW.get(uj.parent)?.q ?? ([0, 0, 0, 1] as Quat) : ([0, 0, 0, 1] as Quat)
  const ref = (name: string) => rt.spec.target.find(j => j.name === name)!.r
  pose.rot.set(u, qalign(qnorm(qmul(qinv(parentQ), uq)), pose.rot.get(u) ?? ref(u)))
  pose.rot.set(l, qalign(qnorm(qmul(qinv(uq), lq)), pose.rot.get(l) ?? ref(l)))
  pose.rot.set(h, qalign(qnorm(qmul(qinv(lq), H.q)), pose.rot.get(h) ?? ref(h)))
  tW.set(u, { p: U.p, q: uq })
  tW.set(l, { p: elbow, q: lq })
  tW.set(h, { p: hand, q: H.q })
  return true
}

export function makeRetargeter(spec: RetargetSpec): Retargeter {
  const rRest = worldOf(spec.retail)
  const tRest = worldOf(spec.target)
  const rRestInv = new Map([...rRest].map(([k, w]) => [k, qinv(w.q)]))
  const mapped = new Set(Object.keys(spec.map))
  const hipChain = new Set(chainOf(spec.retail, [spec.hip.retail]).map(j => j.name))
  const hipT = spec.target.find(j => j.name === spec.hip.target)!
  return {
    spec,
    retailJoints: spec.retail.map(j => j.name),
    retailRest: rRest,
    targetRest: tRest,
    pose(retail) {
      // retail FK: rotations everywhere; translations only on the hip's chain (the root path), rest elsewhere
      const rW = worldOf(spec.retail, j => {
        const o = retail(j.name)
        if (!o) return undefined
        return { r: o.r, t: hipChain.has(j.name) ? o.t : undefined }
      })
      const rot = new Map<string, Quat>()
      const tW = new Map<string, World>()
      let hip: Vec3 = hipT.t
      for (const j of spec.target) {
        const parent = j.parent ? tW.get(j.parent) : undefined
        const pq: Quat = parent?.q ?? [0, 0, 0, 1]
        let q: Quat
        if (mapped.has(j.name)) {
          const rj = spec.map[j.name]!
          const d = qmul(rW.get(rj)!.q, rRestInv.get(rj)!)
          q = qnorm(qmul(d, tRest.get(j.name)!.q))
          rot.set(j.name, qalign(qnorm(qmul(qinv(pq), q)), j.r))
        } else {
          q = qnorm(qmul(pq, j.r))
        }
        let p: Vec3 = parent ? add(parent.p, qrot(parent.q, j.t)) : j.t
        if (j.name === spec.hip.target) {
          const moved = scale(sub(rW.get(spec.hip.retail)!.p, rRest.get(spec.hip.retail)!.p), spec.hip.scale)
          p = add(tRest.get(j.name)!.p, moved)
          hip = parent ? qrot(qinv(parent.q), sub(p, parent.p)) : p
        }
        tW.set(j.name, { p, q })
      }
      return { rot, hip, retailWorld: rW, targetWorld: tW }
    },
  }
}
