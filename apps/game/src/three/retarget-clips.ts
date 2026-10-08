// Licensed characters (docs/CHARACTERS.md §16): a retail clip (AnimationGroup of a pack, keyed on the biped joints)
// rebuilt for a body with its own skeleton through retarget.ts: one rotation track per mapped target joint and the hip
// translation, sampled at every frame of the clip. No other translation, no scale (the §15 lessons).
import { Animation, AnimationGroup, Quaternion, Vector3, type Scene, type TransformNode } from '@babylonjs/core'
import { offHandIk, socketFrame, socketLocal, type Quat, type Retargeter, type RetargetSpec, type Vec3, type World } from './retarget.ts'

/**
 * Weapon packs whose clips hold the weapon in both hands (CHARACTERS §16.8): the weapon's socket (a retail joint) and
 * the side of the off hand that goes back onto it by IK. Spear and glaive share the spear pack; the bow hangs on the
 * left hand and the right hand draws. Swords, blades and shields are one-handed: their clips are left as they are.
 */
export const PACK_IK: Readonly<Record<string, { main: string; off: 'l' | 'r' }>> = {
  spear: { main: 'Bip01 R HandMid', off: 'l' },
  bow: { main: 'Bip01 L Hand', off: 'r' },
}
/** Stand-ins that follow their retail joint's keys in a clip (the weapon sockets: the polearm slides through the hand). */
const ANIMATED_SOCKET = /HandMid/

export interface RetargetGroupOptions {
  /** The animation pack the clip comes from (its PACK_IK entry turns the off-hand IK on). */
  pack?: string
  /**
   * A partial (overlay) clip, like DAMAGE1 (the flinch keys only Spine1, Neck, Neck1 and Head): only the target joints
   * whose retail joint the clip keys get a track, and no hip track, so the overlay wins on those joints alone and the
   * base clip (run, attack, stance) plays on everywhere else, as in retail. Without it the rebuilt clip keyed every
   * mapped joint (the unkeyed ones at the retail rest) and the flinch pinned the whole body to that rest instead.
   * Default: partial when the source keys nothing on the hip's joint.
   */
  partial?: boolean
}

/** The retarget spec of a sidecar (licensed bodies), or null. */
export function retargetSpecOf(sidecar: Record<string, unknown> | null | undefined): RetargetSpec | null {
  const s = sidecar?.retarget as RetargetSpec | undefined
  return s && s.version === 1 && Array.isArray(s.target) && Array.isArray(s.retail) && s.map && s.hip ? s : null
}

/** A clip rebuilt for one spec: its tracks by target joint name (shared by every actor of the spec). */
interface RetargetedClip {
  tracks: { target: string; anim: Animation }[]
  from: number
  to: number
}

/**
 * Rebuilt clips per spec (one spec object per licensed glb, shared by its actors) and source clip + pack: the retarget
 * (FK of both skeletons per frame, the IK) runs once per body file, not once per actor (100 players would redo it 100
 * times), and the actors share the Animation objects, so the crowd tier's VAT bakes each clip once per skeleton.
 */
const retargetCache = new WeakMap<RetargetSpec, Map<string, RetargetedClip>>()

export function retargetGroup(src: AnimationGroup, name: string, rt: Retargeter, joints: ReadonlyMap<string, TransformNode>, scene: Scene, opts: RetargetGroupOptions = {}): AnimationGroup {
  let bySpec = retargetCache.get(rt.spec)
  if (!bySpec) retargetCache.set(rt.spec, (bySpec = new Map()))
  const key = `${src.uniqueId}|${opts.pack ?? ''}|${opts.partial ?? ''}|${name}`
  let clip = bySpec.get(key)
  if (!clip) bySpec.set(key, (clip = retargetClip(src, name, rt, opts)))
  const g = new AnimationGroup(name, scene)
  for (const t of clip.tracks) {
    const node = joints.get(t.target)
    if (node) g.addTargetedAnimation(t.anim, node)
  }
  g.normalize(clip.from, clip.to)
  return g
}

function retargetClip(src: AnimationGroup, name: string, rt: Retargeter, opts: RetargetGroupOptions): RetargetedClip {
  const tracks = new Map<string, { r?: Animation; t?: Animation }>()
  const srcNodes = new Map<string, TransformNode>()
  let fps = 30
  for (const ta of src.targetedAnimations) {
    const n = (ta.target as { name?: string } | null)?.name
    if (!n) continue
    const p = ta.animation.targetProperty
    if (p !== 'rotationQuaternion' && p !== 'position') continue
    srcNodes.set(n, ta.target as TransformNode)
    const e = tracks.get(n) ?? {}
    if (p === 'rotationQuaternion') e.r = ta.animation
    else e.t = ta.animation
    tracks.set(n, e)
    fps = ta.animation.framePerSecond || fps
  }
  const from = src.from, to = src.to
  // a partial clip drives only the joints it keys (the overlay rule, models.ts): their target joints, no hip
  const partial = opts.partial ?? !tracks.has(rt.spec.hip.retail)
  const keyedTarget = partial ? new Set(Object.entries(rt.spec.map).filter(([, r]) => tracks.get(r)?.r).map(([t]) => t)) : null
  const frames: number[] = []
  for (let f = from; f < to - 1e-6; f += 1) frames.push(f)
  frames.push(to)
  const rot = new Map<string, { frame: number; value: Quaternion }[]>()
  const hip: { frame: number; value: Vector3 }[] = []
  const prev = new Map<string, Quat>()
  // the sockets that follow their retail joint (and the IK's socket): the chain from the anchor down, from the pack's nodes
  const ik = opts.pack ? PACK_IK[opts.pack] : undefined
  const sockets = new Map<string, { chain: TransformNode[]; c: Quat; node: boolean; keys: { frame: number; p: Vector3; q: Quaternion }[] }>()
  for (const s of Object.keys(rt.spec.sockets)) {
    if (!(ANIMATED_SOCKET.test(s) || s === ik?.main)) continue
    const fr = socketFrame(rt, s)
    if (!fr) continue
    const chain: TransformNode[] = []
    let n: TransformNode | null = srcNodes.get(s) ?? null
    if (s !== fr.anchorR) {
      while (n && n.name !== fr.anchorR) {
        chain.unshift(n)
        n = n.parent as TransformNode | null
      }
      if (!n) continue
    }
    sockets.set(s, { chain, c: fr.c, node: s !== fr.anchorR, keys: [] })
  }
  const local = (node: TransformNode, f: number): World => {
    const e = tracks.get(node.name)
    const r = (e?.r?.evaluate(f) as Quaternion | undefined) ?? node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation)
    const t = (e?.t?.evaluate(f) as Vector3 | undefined) ?? node.position
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] }
  }
  const relOf = (chain: readonly TransformNode[], f: number): World => {
    let w: World = { p: [0, 0, 0], q: [0, 0, 0, 1] }
    for (const n of chain) {
      const l = local(n, f)
      w = { p: [w.p[0] + rotP(w.q, l.p)[0], w.p[1] + rotP(w.q, l.p)[1], w.p[2] + rotP(w.q, l.p)[2]], q: mulQ(w.q, l.q) }
    }
    return w
  }
  for (const f of frames) {
    const pose = rt.pose(nm => {
      const e = tracks.get(nm)
      if (!e) return undefined
      const r = e.r?.evaluate(f) as Quaternion | undefined
      const t = e.t?.evaluate(f) as Vector3 | undefined
      return { r: r ? ([r.x, r.y, r.z, r.w] as Quat) : undefined, t: t ? ([t.x, t.y, t.z] as Vec3) : undefined }
    })
    for (const [s, k] of sockets) {
      const rel = relOf(k.chain, f)
      if (k.node) {
        const l = socketLocal(k.c, rel)
        k.keys.push({ frame: f, p: new Vector3(l.p[0], l.p[1], l.p[2]), q: new Quaternion(l.q[0], l.q[1], l.q[2], l.q[3]) })
      }
      if (ik && s === ik.main) offHandIk(rt, pose, s, rel, ik.off)
    }
    for (const [j, q0] of pose.rot) {
      // the shorter way from the previous key (q and −q are one rotation; the slerp must not take the long way)
      const p = prev.get(j)
      const q: Quat = p && p[0] * q0[0] + p[1] * q0[1] + p[2] * q0[2] + p[3] * q0[3] < 0 ? [-q0[0], -q0[1], -q0[2], -q0[3]] : q0
      prev.set(j, q)
      let ks = rot.get(j)
      if (!ks) rot.set(j, (ks = []))
      ks.push({ frame: f, value: new Quaternion(q[0], q[1], q[2], q[3]) })
    }
    hip.push({ frame: f, value: new Vector3(pose.hip[0], pose.hip[1], pose.hip[2]) })
  }
  const out: RetargetedClip['tracks'] = []
  for (const [j, ks] of rot) {
    if (keyedTarget && !keyedTarget.has(j)) continue
    const a = new Animation(`${name}:${j}`, 'rotationQuaternion', fps, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE)
    a.setKeys(ks)
    out.push({ target: j, anim: a })
  }
  if (!partial) {
    const a = new Animation(`${name}:${rt.spec.hip.target}:pos`, 'position', fps, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    a.setKeys(hip)
    out.push({ target: rt.spec.hip.target, anim: a })
  }
  for (const [s, k] of sockets) {
    if (!k.node || !k.keys.length || (partial && !tracks.has(s))) continue
    const p = new Animation(`${name}:${s}:pos`, 'position', fps, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    p.setKeys(k.keys.map(x => ({ frame: x.frame, value: x.p })))
    out.push({ target: s, anim: p })
    const r = new Animation(`${name}:${s}:rot`, 'rotationQuaternion', fps, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE)
    r.setKeys(k.keys.map(x => ({ frame: x.frame, value: x.q })))
    out.push({ target: s, anim: r })
  }
  return { tracks: out, from, to }
}

function mulQ(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}
function rotP(q: Quat, v: Vec3): Vec3 {
  const p = mulQ(mulQ(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]])
  return [p[0], p[1], p[2]]
}
