/**
 * The movement clips (docs/MOVEMENT.md §2.2, §3; lane MV-A owns this file):
 *
 *   pnpm sro moves [--skel europeman_skel,europewoman_skel] [--no-key] [--out <out root>] [--work <dir>]
 *
 * 1. Keys content/moves/<skel>/*.json in Blender 5.2, headless (../blender.ts `runBlender`, the sro.config.json key
 *    `blenderExe`), with packages/convert/tools/blender/moves/key_moves.py. Out, per skeleton, in <work>/<skel>/
 *    (default work/out/moves/; never committed, moves.blend holds the retail mesh): moves.blend, moves_blender.glb and
 *    moves_keys.json. `--no-key` skips this step and re-packs the last keyer output.
 * 2. Re-expresses Blender's export on the retail skeleton. Blender re-orients every joint's rest frame (MOVEMENT §3.3
 *    finding 1: 42 joints by 120°, one by 90°), so its local keys are not in pack format. Per joint:
 *      C = inv(G_orig_rest) · G_exp_rest;   G_orig(t) = G_exp(t) · inv(C);   local = inv(G_orig_parent(t)) · G_orig(t)
 *    (the maths of work/tmp/movement/polish/make_pack2.py).
 * 3. Writes the pack and its index (docs/ASSETS.md §5.3):
 *      <out>/char/_anims/<skel>/movement.glb    the skeleton's joints (same names and rest TRS as every other pack of
 *                                               that skeleton) and the clips <prefix>_jump, <prefix>_jump_run, …
 *      <out>/char/_anims/<skel>/movement.json   MovementIndex: per kind (JUMP, JUMP_RUN, JUMP_RUN_FIST) the pack
 *                                               animation, duration, events and `air`; `runJumps` maps each RUN clip
 *                                               a player runs to its JUMP_RUN kind, with `enterPhaseS`/`exitPhaseS`
 *    and <work>/<skel>/roundtrip.json (every check below with its numbers). The optimizer (../optimize/run.ts) copies
 *    both into out-opt, the glb with lossless meshopt like every pack.
 *
 * The checks (MOVEMENT §8.2, WAVE_PLAN6 §5 row MV-A); any failure makes the verb exit 1:
 *  - control: the retail STAND1, sent through the same Blender import/export and re-expressed, matches the converter's
 *    own STAND1 within 0.1° and 1e-5 m;
 *  - the pack clip on the retail skeleton puts every joint within 0.1 mm of Blender's own result;
 *  - planted contacts within 1 mm of the idle's ground contact (the lower of the toe joint and a virtual heel 3 cm
 *    behind the ankle, as the keyer measures), planted slide ≤ 10 mm per frame (against the RUN clip's own toe track
 *    for a running clip), `air` ≥ −0.02 m on every frame;
 *  - no net root travel: the XZ excursion of Bip01 ≤ 0.15 m and ≤ 1 cm between the first and last frame;
 *  - each clip ≤ 60 KB raw;
 *  - every RUN clip a player can run (the groups in RUN_GROUPS) maps to a JUMP_RUN, and that JUMP_RUN's first and last
 *    frames put the feet within 1 cm of the RUN at `enterPhaseS` / `exitPhaseS` (a `blendFor` RUN, served through the
 *    client's entry and exit blends, within BLEND_MATCH_M; MOVEMENT §3.3 priority 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Animation, AnimationSampler, Document } from '@gltf-transform/core'
import { runBlender } from '../blender.ts'
import { REPO_ROOT, type SroConfig } from '../node-io.ts'
import { createPackDocument, PACK_DIR, sampleChannel } from '../optimize/anim.ts'
import { gltfIO } from '../optimize/io.ts'

// ------------------------------------------------------------------------------------------------ constants

/** The skeletons that get movement clips: the key files' folder name = the pack folder (the .bsk basename). */
export const MOVE_SKELETONS = {
  europeman_skel: { prefix: 'chinaman', char: 'char/china/chinaman_adventurer.glb' },
  europewoman_skel: { prefix: 'chinawoman', char: 'char/china/chinawoman_adventurer.glb' },
} as const
export type MoveSkeleton = keyof typeof MOVE_SKELETONS

/**
 * The aniGroups whose RUN a player really runs (fists, sword/blade, spear/glaive, bow). `cart` is the mounted pose (a
 * mounted jump is refused, MOVEMENT §4.3) and the `avatar_*` packs are never loaded (models.ts SKIP_PACKS).
 */
export const RUN_GROUPS = ['default', 'sword', 'spear', 'bow'] as const

export const FPS = 30
/** glTF +Z is the characters' forward (Blender −Y); +Y is up. */
const FWD = 2
const UP = 1
/** The keyer's virtual heel: 3 cm behind the ankle at the idle's toe height (key_moves.py `Rig.heel`). */
const HEEL_BACK_M = 0.03

/** MOVEMENT §8.2 / WAVE_PLAN6 §5 thresholds. */
export const LIMITS = {
  controlDeg: 0.1,
  controlM: 1e-5,
  packVsExportM: 1e-4,
  plantedM: 0.001,
  slideM: 0.01,
  minAirM: -0.02,
  rootExcursionM: 0.15,
  rootEndsM: 0.01,
  clipBytes: 60 * 1024,
  runMatchM: 0.01,
} as const
/**
 * A `blendFor` RUN (female sword, spear, bow) is not the cycle its JUMP_RUN was keyed on; the client's 0.25 s entry and
 * 0.12 s exit blends hide the difference (MOVEMENT §3.3: 2.6–22 cm apart on the leg track). This bound only catches a
 * wrong phase or a wrong clip (a leg a whole stride off is ~0.9 m).
 */
export const BLEND_MATCH_M = 0.3

// ------------------------------------------------------------------------------------------------ 4×4 maths

/** Column-major 4×4 (glTF order: m[col * 4 + row]). */
export type Mat4 = Float64Array
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
export interface JointPose { t: Vec3, q: Quat }

export function compose(t: readonly number[], q: readonly number[], s: readonly number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number]
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ]
  const m = new Float64Array(16)
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] = r[c * 3 + rr]! * s[c]!
  m[12] = t[0]!
  m[13] = t[1]!
  m[14] = t[2]!
  m[15] = 1
  return m
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const m = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0
      for (let k = 0; k < 4; k++) v += a[k * 4 + r]! * b[c * 4 + k]!
      m[c * 4 + r] = v
    }
  }
  return m
}

/** Inverse of an affine matrix (any invertible 3×3 part). */
export function invert(m: Mat4): Mat4 {
  const a = (r: number, c: number) => m[c * 4 + r]!
  const c00 = a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)
  const c01 = a(1, 2) * a(2, 0) - a(1, 0) * a(2, 2)
  const c02 = a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0)
  const det = a(0, 0) * c00 + a(0, 1) * c01 + a(0, 2) * c02
  if (Math.abs(det) < 1e-15) throw new Error('singular joint matrix')
  const i = 1 / det
  // inv[r][c] = cofactor[c][r] / det
  const inv = [
    [c00 * i, (a(0, 2) * a(2, 1) - a(0, 1) * a(2, 2)) * i, (a(0, 1) * a(1, 2) - a(0, 2) * a(1, 1)) * i],
    [c01 * i, (a(0, 0) * a(2, 2) - a(0, 2) * a(2, 0)) * i, (a(0, 2) * a(1, 0) - a(0, 0) * a(1, 2)) * i],
    [c02 * i, (a(0, 1) * a(2, 0) - a(0, 0) * a(2, 1)) * i, (a(0, 0) * a(1, 1) - a(0, 1) * a(1, 0)) * i],
  ]
  const out = new Float64Array(16)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = inv[r]![c]!
    out[12 + r] = -(inv[r]![0]! * m[12]! + inv[r]![1]! * m[13]! + inv[r]![2]! * m[14]!)
  }
  out[15] = 1
  return out
}

export const translationOf = (m: Mat4): Vec3 => [m[12]!, m[13]!, m[14]!]

/** A point through an affine matrix. */
export function apply(m: Mat4, p: readonly number[]): Vec3 {
  const out: Vec3 = [0, 0, 0]
  for (let r = 0; r < 3; r++) out[r] = m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!
  return out
}

/** The rotation of a matrix (each column normalised first, so a joint scale does not leak in), as x, y, z, w. */
export function rotationOf(m: Mat4): Quat {
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let c = 0; c < 3; c++) {
    const n = Math.hypot(m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!) || 1
    for (let r = 0; r < 3; r++) R[r]![c] = m[c * 4 + r]! / n
  }
  const e = (r: number, c: number) => R[r]![c]!
  const tr = e(0, 0) + e(1, 1) + e(2, 2)
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(e(2, 1) - e(1, 2)) / s, (e(0, 2) - e(2, 0)) / s, (e(1, 0) - e(0, 1)) / s, 0.25 * s]
  } else if (e(0, 0) > e(1, 1) && e(0, 0) > e(2, 2)) {
    const s = Math.sqrt(1 + e(0, 0) - e(1, 1) - e(2, 2)) * 2
    q = [0.25 * s, (e(0, 1) + e(1, 0)) / s, (e(0, 2) + e(2, 0)) / s, (e(2, 1) - e(1, 2)) / s]
  } else if (e(1, 1) > e(2, 2)) {
    const s = Math.sqrt(1 + e(1, 1) - e(0, 0) - e(2, 2)) * 2
    q = [(e(0, 1) + e(1, 0)) / s, 0.25 * s, (e(1, 2) + e(2, 1)) / s, (e(0, 2) - e(2, 0)) / s]
  } else {
    const s = Math.sqrt(1 + e(2, 2) - e(0, 0) - e(1, 1)) * 2
    q = [(e(0, 2) + e(2, 0)) / s, (e(1, 2) + e(2, 1)) / s, 0.25 * s, (e(1, 0) - e(0, 1)) / s]
  }
  const n = Math.hypot(...q)
  return q.map(v => v / n) as Quat
}

/** A unit quaternion (anim.ts `sampleChannel` lerps nearly equal keys without renormalising). */
export function normalize(q: readonly number[]): Quat {
  const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1
  return [q[0]! / n, q[1]! / n, q[2]! / n, q[3]! / n]
}

/** The angle between two rotations, in degrees (q and −q are the same rotation; either may be unnormalised). */
export function quatAngleDeg(a: readonly number[], b: readonly number[]): number {
  const d = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!) / (Math.hypot(...a) * Math.hypot(...b) || 1)
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)

// ------------------------------------------------------------------------------------------------ rigs

/** A glTF node tree with its rest TRS, sampled by node index. */
export interface Rig {
  doc: Document
  /** Node name -> index; a skin joint wins over any other node of the same name. */
  byName: Map<string, number>
  parent: number[]
  rest: { t: number[], q: number[], s: number[] }[]
}

export function rigOf(doc: Document): Rig {
  const nodes = doc.getRoot().listNodes()
  const index = new Map(nodes.map((n, i) => [n, i]))
  const byName = new Map<string, number>()
  for (const j of doc.getRoot().listSkins()[0]?.listJoints() ?? []) byName.set(j.getName(), index.get(j)!)
  nodes.forEach((n, i) => {
    if (!byName.has(n.getName())) byName.set(n.getName(), i)
  })
  return {
    doc,
    byName,
    parent: nodes.map(n => {
      const p = n.getParentNode()
      return p ? index.get(p)! : -1
    }),
    rest: nodes.map(n => ({ t: n.getTranslation(), q: n.getRotation(), s: n.getScale() })),
  }
}

export function jointIndex(rig: Rig, name: string): number {
  const i = rig.byName.get(name)
  if (i === undefined) throw new Error(`no joint ${JSON.stringify(name)}`)
  return i
}

export type Channels = Map<string, AnimationSampler>

export function findAnimation(doc: Document, name: string): Animation {
  const a = doc.getRoot().listAnimations().find(x => x.getName() === name)
  if (!a) throw new Error(`no animation ${JSON.stringify(name)}; have ${doc.getRoot().listAnimations().slice(0, 12).map(x => x.getName()).join(', ')}`)
  return a
}

export function channelsOf(rig: Rig, anim: Animation): Channels {
  const nodes = rig.doc.getRoot().listNodes()
  const index = new Map(nodes.map((n, i) => [n, i]))
  const ch: Channels = new Map()
  for (const c of anim.listChannels()) {
    const n = c.getTargetNode()
    if (n) ch.set(`${index.get(n)}|${c.getTargetPath()}`, c.getSampler()!)
  }
  return ch
}

/** Every key time of a clip (union over its channels, rounded to 10 µs). */
export function keyTimes(anim: Animation): number[] {
  const ts = new Set<number>()
  for (const s of anim.listSamplers()) for (const t of s.getInput()!.getArray()!) ts.add(Math.round(t * 1e5) / 1e5)
  return [...ts].sort((a, b) => a - b)
}

export function localsAt(rig: Rig, ch: Channels | null, t: number): Mat4[] {
  return rig.rest.map((r, i) => {
    const get = (path: string, rest: number[]) => {
      const s = ch?.get(`${i}|${path}`)
      return s ? sampleChannel(s, t, []) : rest
    }
    return compose(get('translation', r.t), normalize(get('rotation', r.q)), get('scale', r.s))
  })
}

export function globalsOf(rig: Rig, locals: Mat4[]): Mat4[] {
  const g: (Mat4 | undefined)[] = new Array(locals.length)
  const at = (i: number): Mat4 => {
    const p = rig.parent[i]!
    return (g[i] ??= p < 0 ? locals[i]! : mul(at(p), locals[i]!))
  }
  for (let i = 0; i < locals.length; i++) at(i)
  return g as Mat4[]
}

/** Global joint matrices of `rig` at time `t` of `anim` (null: the rest pose). */
export function globalsAt(rig: Rig, ch: Channels | null, t: number): Mat4[] {
  return globalsOf(rig, localsAt(rig, ch, t))
}

// ------------------------------------------------------------------------------------------------ re-expression

/** How to turn a pose of the exported rig into local joint poses of the original skeleton. */
export interface Retarget {
  joints: string[]
  origIdx: number[]
  expIdx: number[]
  /** inv(C) per joint. */
  invC: Mat4[]
  /** The parent of each joint: an index into `joints`, or -1 (then `parentRest` holds a non-joint parent's rest). */
  parentJoint: number[]
  parentRest: (Mat4 | null)[]
  /** Rotation angle of each C, in degrees (Blender's rest re-orientation; MOVEMENT §3.3 finding 1). */
  reorientDeg: number[]
}

export function retarget(orig: Rig, exp: Rig, joints: readonly string[]): Retarget {
  const go = globalsAt(orig, null, 0)
  const ge = globalsAt(exp, null, 0)
  const origIdx = joints.map(n => jointIndex(orig, n))
  const expIdx = joints.map(n => jointIndex(exp, n))
  const pos = new Map(joints.map((n, k) => [origIdx[k]!, k]))
  const C = joints.map((_n, k) => mul(invert(go[origIdx[k]!]!), ge[expIdx[k]!]!))
  return {
    joints: [...joints],
    origIdx,
    expIdx,
    invC: C.map(invert),
    parentJoint: origIdx.map(i => pos.get(orig.parent[i]!) ?? -1),
    parentRest: origIdx.map(i => {
      const p = orig.parent[i]!
      return p < 0 || pos.has(p) ? null : go[p]!
    }),
    reorientDeg: C.map(c => quatAngleDeg(rotationOf(c), [0, 0, 0, 1])),
  }
}

/** One exported pose (the exported rig's global matrices) -> the original skeleton's local joint poses. */
export function reexpressPose(r: Retarget, expGlobals: Mat4[]): JointPose[] {
  const g = r.expIdx.map((e, k) => mul(expGlobals[e]!, r.invC[k]!))
  return g.map((m, k) => {
    const p = r.parentJoint[k]!
    const pr = r.parentRest[k]
    const local = p >= 0 ? mul(invert(g[p]!), m) : pr ? mul(invert(pr), m) : m
    return { t: translationOf(local), q: rotationOf(local) }
  })
}

export interface ReexpressedClip {
  /** Seconds from 0. */
  times: number[]
  /** [frame][joint] */
  poses: JointPose[][]
}

/** Every key time of the exported clip, re-expressed; quaternions kept on one hemisphere per joint. */
export function reexpressClip(r: Retarget, exp: Rig, anim: Animation): ReexpressedClip {
  const ch = channelsOf(exp, anim)
  const ts = keyTimes(anim)
  const poses = ts.map(t => reexpressPose(r, globalsAt(exp, ch, t)))
  for (let f = 1; f < poses.length; f++) {
    poses[f]!.forEach((p, k) => {
      const a = poses[f - 1]![k]!.q
      if (a[0] * p.q[0] + a[1] * p.q[1] + a[2] * p.q[2] + a[3] * p.q[3] < 0) p.q = p.q.map(v => -v) as Quat
    })
  }
  return { times: ts.map(t => Math.round((t - ts[0]!) * 1e5) / 1e5), poses }
}

// ------------------------------------------------------------------------------------------------ the pack

export interface PackClip {
  anim: string
  clip: ReexpressedClip
}

/**
 * The movement pack: `template`'s skin joints (names, hierarchy, rest TRS; optimize/anim.ts createPackDocument) and
 * one LINEAR animation per clip: a rotation channel on every joint, a translation channel where it leaves the rest.
 */
export function buildMovementPack(template: Document, name: string, joints: readonly string[], clips: readonly PackClip[]): Document {
  const doc = createPackDocument(template, name)
  const buffer = doc.getRoot().listBuffers()[0]!
  const nodes = new Map(doc.getRoot().listNodes().map(n => [n.getName(), n]))
  for (const { anim, clip } of clips) {
    const a = doc.createAnimation(anim)
    const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(clip.times)).setBuffer(buffer)
    joints.forEach((j, k) => {
      const node = nodes.get(j)
      if (!node) throw new Error(`pack template has no joint ${j}`)
      const add = (path: 'rotation' | 'translation', type: 'VEC4' | 'VEC3', values: number[]) => {
        const out = doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer)
        const s = doc.createAnimationSampler().setInput(input).setOutput(out).setInterpolation('LINEAR')
        a.addSampler(s)
        a.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(s))
      }
      add('rotation', 'VEC4', clip.poses.flatMap(p => p[k]!.q))
      const rest = node.getTranslation()
      if (clip.poses.some(p => dist(p[k]!.t, rest) > 1e-5)) add('translation', 'VEC3', clip.poses.flatMap(p => p[k]!.t))
    })
  }
  return doc
}

/** Raw bytes of a clip's key data (times + outputs, float32). */
export function clipBytes(anim: Animation): number {
  const seen = new Set<unknown>()
  let n = 0
  for (const s of anim.listSamplers()) {
    for (const acc of [s.getInput()!, s.getOutput()!]) {
      if (seen.has(acc)) continue
      seen.add(acc)
      n += acc.getArray()!.byteLength
    }
  }
  return n
}

// ------------------------------------------------------------------------------------------------ the index

export interface MovementEvent {
  timeMs: number
  /** The retail sidecar's footstep event type. */
  type: 2
  p1: 'takeoff' | 'land'
  p2: 0
}

export interface MovementClipIndex {
  /** The animation's name in the pack. */
  anim: string
  durationMs: number
  fps: number
  frames: number
  takeoffMs: number
  touchMs: number
  events: MovementEvent[]
  /** The lowest foot contact above the ground per 1/30 s (m; 0 on planted frames): the entity root never rises. */
  air: number[]
  /** A running clip: the RUN it was keyed on, and where in that cycle it starts and hands the RUN back. */
  run?: string
  runCycleS?: number
  enterPhaseS?: number
  exitPhaseS?: number
  /** The RUN clips it matches within 1 cm at both ends, and those it serves through the client's blends. */
  for?: string[]
  blendFor?: string[]
}

/** <out>/char/_anims/<skel>/movement.json (docs/ASSETS.md §5.3). */
export interface MovementIndex {
  format: 'sro-movement'
  version: 1
  skeleton: string
  /** Out-root-relative pack path. */
  pack: string
  /** Keyed by clip kind: JUMP, JUMP_RUN, JUMP_RUN_FIST. */
  clips: Record<string, MovementClipIndex>
  /** Every RUN clip a player runs -> the kind of its JUMP_RUN. */
  runJumps: Record<string, string>
}

export const packPath = (skel: string) => `${PACK_DIR}/${skel}/movement.glb`
export const indexPath = (skel: string) => `${PACK_DIR}/${skel}/movement.json`

// ------------------------------------------------------------------------------------------------ the keyer's output

type Side = 'L' | 'R'
const SIDES: readonly Side[] = ['L', 'R']

export interface KeyedClip {
  action: string
  kind: string
  frames: number
  durationMs: number
  fps: number
  takeoffMs: number
  touchMs: number
  events: { timeMs: number, type: string }[]
  air: number[]
  planted: boolean[]
  run?: string
  runFrames?: number
  runCycleS?: number
  runContacts?: Record<Side, { start: number, end: number, startS: number }>
  enterPhaseS?: number | null
  exitPhaseS?: number | null
  for?: string[]
  blendFor?: string[]
}

export interface KeyerOutput {
  prefix: string
  fps: number
  controlAction: string
  sourceGlb: string
  toe0Z: number
  clips: Record<string, KeyedClip>
}

/** A key file (content/moves/<skel>/<clip>.json): only what the checks read. */
export interface MoveSpec {
  clip: string
  kind: string
  lock: 'fixed' | 'run'
  run?: string
  contacts: { from: number, to: number, feet: string, runPhase?: string }[]
}

const PHASE = /^\s*(?:([LR])-contact)?\s*([+-]?\s*\d+(?:\.\d+)?)?\s*$/

/** run_contacts.py `resolve_phase`: "R-contact", "L-contact+0.1" or "0.4" -> seconds into the cycle, on the 30 fps grid. */
export function resolvePhase(expr: string, contacts: Record<Side, { startS: number }>, cycleS: number): number {
  const m = PHASE.exec(expr)
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`bad RUN phase ${JSON.stringify(expr)}`)
  let t = m[1] ? contacts[m[1] as Side].startS : 0
  if (m[2]) t += Number(m[2].replace(/\s/g, ''))
  t = ((t % cycleS) + cycleS) % cycleS
  return (Math.round(Math.round(t * FPS) / FPS * 1e6) / 1e6) % cycleS
}

// ------------------------------------------------------------------------------------------------ measurements

/** The idle's ground and the virtual heels (key_moves.py `Rig.__init__`), from the original rig's STAND1 at 0. */
export interface Ground {
  toe0: number
  heel: Record<Side, Vec3>
}

export function groundOf(orig: Rig): Ground {
  const g = globalsAt(orig, channelsOf(orig, findAnimation(orig.doc, 'STAND1')), 0)
  const at = (n: string) => g[jointIndex(orig, n)]!
  const toe0 = Math.min(...SIDES.map(s => translationOf(at(`Bip01 ${s} Toe0`))[UP]))
  const heel = {} as Record<Side, Vec3>
  for (const s of SIDES) {
    const foot = at(`Bip01 ${s} Foot`)
    const w = translationOf(foot)
    w[FWD] -= HEEL_BACK_M
    w[UP] = toe0
    heel[s] = apply(invert(foot), w)
  }
  return { toe0, heel }
}

/** Per frame of a pack clip: the feet, the root and the pelvis. */
export interface FrameMeasure {
  /** Lowest contact (toe joint or virtual heel) per side, metres above the idle's ground. */
  contact: Record<Side, number>
  air: number
  toeFwd: Record<Side, number>
  feet: Record<`${Side}${'Foot' | 'Toe0'}`, Vec3>
  root: Vec3
  pelvisY: number
}

export function measureFrame(rig: Rig, g: Mat4[], ground: Ground): FrameMeasure {
  const at = (n: string) => g[jointIndex(rig, n)]!
  const contact = {} as Record<Side, number>
  const toeFwd = {} as Record<Side, number>
  const feet = {} as FrameMeasure['feet']
  for (const s of SIDES) {
    const toe = translationOf(at(`Bip01 ${s} Toe0`))
    const foot = at(`Bip01 ${s} Foot`)
    contact[s] = Math.min(toe[UP], apply(foot, ground.heel[s])[UP]) - ground.toe0
    toeFwd[s] = toe[FWD]
    feet[`${s}Foot`] = translationOf(foot)
    feet[`${s}Toe0`] = toe
  }
  return {
    contact,
    air: Math.min(contact.L, contact.R),
    toeFwd,
    feet,
    root: translationOf(at('Bip01')),
    pelvisY: translationOf(at('Bip01 Pelvis'))[UP],
  }
}

/** A RUN clip of the original rig sampled on its own 30 fps grid over one cycle (the keyer's `run_base`). */
export interface RunTrack {
  name: string
  frames: number
  cycleS: number
  toeFwd: Record<Side, number[]>
}

export function runCycleS(orig: Rig, run: string): number {
  return Math.max(...findAnimation(orig.doc, run).listSamplers().map(s => s.getInput()!.getMax([])[0] ?? 0))
}

export function runTrack(orig: Rig, run: string, ground: Ground): RunTrack {
  const ch = channelsOf(orig, findAnimation(orig.doc, run))
  const cycleS = runCycleS(orig, run)
  const frames = Math.round(cycleS * FPS)
  const toeFwd: Record<Side, number[]> = { L: [], R: [] }
  for (let k = 0; k < frames; k++) {
    const m = measureFrame(orig, globalsAt(orig, ch, k / FPS), ground)
    for (const s of SIDES) toeFwd[s].push(m.toeFwd[s])
  }
  return { name: run, frames, cycleS, toeFwd }
}

/** key_moves.py `track_at`: the RUN's own toe track at `phase` seconds, cyclic, linear between its frames. */
export function trackAt(rt: RunTrack, s: Side, phase: number): number {
  const n = rt.frames
  const x = (((phase * FPS) % n) + n) % n
  const i = Math.floor(x)
  const u = x - i
  const tr = rt.toeFwd[s]
  return tr[i % n]! * (1 - u) + tr[(i + 1) % n]! * u
}

/** The feet of the original rig playing `run` at `phase` seconds (wrapped into its cycle). */
export function runFeetAt(orig: Rig, run: string, phase: number, ground: Ground): FrameMeasure['feet'] {
  const cycle = runCycleS(orig, run)
  const t = ((phase % cycle) + cycle) % cycle
  return measureFrame(orig, globalsAt(orig, channelsOf(orig, findAnimation(orig.doc, run)), t), ground).feet
}

export const feetDistance = (a: FrameMeasure['feet'], b: FrameMeasure['feet']) =>
  Math.max(...(Object.keys(a) as (keyof FrameMeasure['feet'])[]).map(k => dist(a[k], b[k])))

export interface ClipCheck {
  anim: string
  kind: string
  frames: number
  durationMs: number
  channels: number
  rawBytes: number
  pelvisApexY: number
  minAirM: number
  maxPlantedM: number
  maxSlideM: number
  rootExcursionM: number
  rootEndsM: number
  /** Largest joint distance between the pack clip and Blender's own export (null when not compared). */
  maxVsExportM: number | null
  /** Largest |air(pack) − air(keyer)|. */
  maxAirVsKeyerM: number
  air: number[]
}

/** The pack clip's per-frame measurements and the §8.2 numbers (thresholds are applied by `failuresOf`). */
export function checkClip(
  pack: Rig,
  anim: Animation,
  ground: Ground,
  keyed: KeyedClip,
  spec: MoveSpec,
  run: RunTrack | null,
): ClipCheck {
  const ch = channelsOf(pack, anim)
  const times = keyTimes(anim)
  const m = times.map(t => measureFrame(pack, globalsAt(pack, ch, t), ground))
  const stance = new Map<number, { feet: Side[], p0: number | null, from: number }>()
  for (const c of spec.contacts) {
    const p0 = c.runPhase !== undefined && keyed.runContacts && keyed.runCycleS
      ? resolvePhase(c.runPhase, keyed.runContacts, keyed.runCycleS)
      : null
    for (let f = c.from; f <= c.to; f++) stance.set(f, { feet: [...c.feet] as Side[], p0, from: c.from })
  }
  let maxPlanted = 0
  let maxSlide = 0
  m.forEach((fm, f) => {
    const st = stance.get(f)
    if (!st) return
    maxPlanted = Math.max(maxPlanted, Math.abs(fm.air))
    const prev = stance.get(f - 1)
    if (f === 0 || !prev) return
    for (const s of st.feet) {
      if (!prev.feet.includes(s)) continue
      let d = fm.toeFwd[s] - m[f - 1]!.toeFwd[s]
      if (spec.lock === 'run' && run && st.p0 !== null) {
        const tr = st.p0 + (f - st.from) / FPS
        d -= trackAt(run, s, tr) - trackAt(run, s, tr - 1 / FPS)
      }
      maxSlide = Math.max(maxSlide, Math.abs(d))
    }
  })
  const r0 = m[0]!.root
  const xz = (p: Vec3) => Math.hypot(p[0] - r0[0], p[2] - r0[2])
  return {
    anim: anim.getName(),
    kind: keyed.kind,
    frames: times.length,
    durationMs: Math.round(times.at(-1)! * 1000),
    channels: anim.listChannels().length,
    rawBytes: clipBytes(anim),
    pelvisApexY: Math.max(...m.map(x => x.pelvisY)),
    minAirM: Math.min(...m.map(x => x.air)),
    maxPlantedM: maxPlanted,
    maxSlideM: maxSlide,
    rootExcursionM: Math.max(...m.map(x => xz(x.root))),
    rootEndsM: xz(m.at(-1)!.root),
    maxVsExportM: null,
    maxAirVsKeyerM: Math.max(...m.map((x, f) => Math.abs(x.air - (keyed.air[f] ?? Infinity)))),
    air: m.map(x => Math.round(x.air * 1e4) / 1e4 + 0),
  }
}

/** The pack clip against Blender's export on the same rest skeleton: the largest joint distance over every key. */
export function packVsExport(pack: Rig, packAnim: Animation, exp: Rig, expAnim: Animation, r: Retarget): number {
  const pch = channelsOf(pack, packAnim)
  const ech = channelsOf(exp, expAnim)
  const et = keyTimes(expAnim)
  const packIdx = r.joints.map(n => jointIndex(pack, n))
  let worst = 0
  for (const t of keyTimes(packAnim)) {
    const gp = globalsAt(pack, pch, t)
    const ge = globalsAt(exp, ech, t + et[0]!)
    r.joints.forEach((_n, k) => {
      const pe = translationOf(mul(ge[r.expIdx[k]!]!, r.invC[k]!))
      worst = Math.max(worst, dist(translationOf(gp[packIdx[k]!]!), pe))
    })
  }
  return worst
}

/** The retail STAND1 through Blender and back against the converter's own STAND1 keys. */
export function controlCheck(orig: Rig, exp: Rig, r: Retarget, control: string): { samples: number, maxRotDeg: number, maxTransM: number } {
  const clip = reexpressClip(r, exp, findAnimation(exp.doc, control))
  const och = channelsOf(orig, findAnimation(orig.doc, 'STAND1'))
  const t0 = keyTimes(findAnimation(exp.doc, control))[0]!
  let maxRotDeg = 0
  let maxTransM = 0
  clip.times.forEach((t, f) => {
    r.origIdx.forEach((oi, k) => {
      const rs = och.get(`${oi}|rotation`)
      const ts = och.get(`${oi}|translation`)
      const q = rs ? sampleChannel(rs, t + t0, []) : orig.rest[oi]!.q
      const p = ts ? sampleChannel(ts, t + t0, []) : orig.rest[oi]!.t
      const got = clip.poses[f]![k]!
      maxRotDeg = Math.max(maxRotDeg, quatAngleDeg(q, got.q))
      maxTransM = Math.max(maxTransM, ...p.map((v, c) => Math.abs(v - got.t[c]!)))
    })
  })
  return { samples: clip.times.length, maxRotDeg, maxTransM }
}

export interface RunMatch {
  run: string
  kind: string
  blend: boolean
  enterM: number
  exitM: number
}

/** A JUMP_RUN's first and last frames against each RUN it serves, at enterPhaseS / exitPhaseS (feet: Foot + Toe0). */
export function runMatches(orig: Rig, pack: Rig, anim: Animation, keyed: KeyedClip, ground: Ground): RunMatch[] {
  const ch = channelsOf(pack, anim)
  const times = keyTimes(anim)
  const first = measureFrame(pack, globalsAt(pack, ch, times[0]!), ground).feet
  const last = measureFrame(pack, globalsAt(pack, ch, times.at(-1)!), ground).feet
  const out: RunMatch[] = []
  for (const [list, blend] of [[keyed.for ?? [], false], [keyed.blendFor ?? [], true]] as const) {
    for (const run of list) {
      out.push({
        run,
        kind: keyed.kind,
        blend,
        enterM: feetDistance(first, runFeetAt(orig, run, keyed.enterPhaseS ?? 0, ground)),
        exitM: feetDistance(last, runFeetAt(orig, run, keyed.exitPhaseS ?? 0, ground)),
      })
    }
  }
  return out
}

/** The RUN clips a player of this character can run (RUN_GROUPS), from its sidecar. */
export function playerRuns(sidecar: { animations?: { name: string, group: string }[] }): string[] {
  return (sidecar.animations ?? [])
    .filter(a => /^RUN(_|$)/.test(a.name) && (RUN_GROUPS as readonly string[]).includes(a.group))
    .map(a => a.name)
}

export interface MovesReport {
  skeleton: string
  prefix: string
  packBytes: number
  restReorientDeg: number[]
  control: { samples: number, maxRotDeg: number, maxTransM: number }
  clips: Record<string, ClipCheck>
  runMatches: RunMatch[]
  playerRuns: string[]
  failures: string[]
}

/** The §8.2 thresholds applied to a report. */
export function failuresOf(r: Omit<MovesReport, 'failures'>, index: MovementIndex): string[] {
  const f: string[] = []
  const L = LIMITS
  if (!(r.control.maxRotDeg <= L.controlDeg)) f.push(`control STAND1 ${r.control.maxRotDeg.toFixed(4)}° > ${L.controlDeg}°`)
  if (!(r.control.maxTransM <= L.controlM)) f.push(`control STAND1 ${r.control.maxTransM.toExponential(2)} m > ${L.controlM} m`)
  for (const [clip, c] of Object.entries(r.clips)) {
    if (c.maxVsExportM !== null && !(c.maxVsExportM <= L.packVsExportM)) f.push(`${clip}: pack vs export ${c.maxVsExportM.toExponential(2)} m`)
    if (!(c.maxPlantedM <= L.plantedM)) f.push(`${clip}: planted contact ${(c.maxPlantedM * 1000).toFixed(2)} mm > 1 mm`)
    if (!(c.maxSlideM <= L.slideM)) f.push(`${clip}: planted slide ${(c.maxSlideM * 1000).toFixed(1)} mm/frame > 10 mm`)
    if (!(c.minAirM >= L.minAirM)) f.push(`${clip}: lowest contact ${c.minAirM.toFixed(3)} m < −0.02 m`)
    if (!(c.rootExcursionM <= L.rootExcursionM)) f.push(`${clip}: root XZ excursion ${c.rootExcursionM.toFixed(3)} m > 0.15 m`)
    if (!(c.rootEndsM <= L.rootEndsM)) f.push(`${clip}: root XZ end offset ${c.rootEndsM.toFixed(3)} m > 1 cm`)
    if (!(c.rawBytes <= L.clipBytes)) f.push(`${clip}: ${c.rawBytes} bytes raw > 60 KB`)
    if (!(c.maxAirVsKeyerM <= 0.001)) f.push(`${clip}: air differs from the keyer's by ${(c.maxAirVsKeyerM * 1000).toFixed(2)} mm`)
  }
  for (const m of r.runMatches) {
    const lim = m.blend ? BLEND_MATCH_M : L.runMatchM
    if (!(Math.max(m.enterM, m.exitM) <= lim)) {
      f.push(`${m.kind} vs ${m.run}${m.blend ? ' (blend)' : ''}: feet ${(m.enterM * 100).toFixed(1)} / ${(m.exitM * 100).toFixed(1)} cm > ${lim * 100} cm`)
    }
  }
  for (const run of r.playerRuns) {
    const kind = index.runJumps[run]
    if (!kind || !index.clips[kind]?.run) f.push(`RUN ${run} has no JUMP_RUN`)
  }
  return f
}

// ------------------------------------------------------------------------------------------------ the export

export interface ExportMovesOptions {
  /** The out root holding char/china/*.glb (default work/out); the pack and index are written under it. */
  outRoot?: string
  /** The keyer's folder root (default <outRoot>/moves). */
  workRoot?: string
  /** Re-pack only: read the last keyer output instead of running Blender. */
  key?: boolean
  cfg?: SroConfig
  log?: (line: string) => void
}

const KEY_SCRIPT = join(REPO_ROOT, 'packages', 'convert', 'tools', 'blender', 'moves', 'key_moves.py')
const KEYS_DIR = join(REPO_ROOT, 'content', 'moves')

/** Keys one skeleton in Blender (key_moves.py), then re-packs it. */
export async function exportMoves(skel: MoveSkeleton, opts: ExportMovesOptions = {}): Promise<{ index: MovementIndex, report: MovesReport }> {
  const log = opts.log ?? (() => {})
  const outRoot = resolve(opts.outRoot ?? join(REPO_ROOT, 'work', 'out'))
  const work = join(resolve(opts.workRoot ?? join(outRoot, 'moves')), skel)
  const { prefix, char } = MOVE_SKELETONS[skel]
  const charGlb = join(outRoot, ...char.split('/'))
  if (!existsSync(charGlb)) throw new Error(`moves: ${charGlb} is missing (run the character conversion first)`)
  if (opts.key !== false) {
    mkdirSync(work, { recursive: true })
    log(`${skel}: keying in Blender…`)
    const res = await runBlender(opts.cfg, {
      script: KEY_SCRIPT,
      args: [charGlb, join(KEYS_DIR, skel), work, { value: prefix }],
      timeoutMs: 10 * 60_000,
    })
    log(`${skel}: keyed in ${(res.ms / 1000).toFixed(1)} s`)
  }
  const keyer = JSON.parse(readFileSync(join(work, 'moves_keys.json'), 'utf8')) as KeyerOutput
  if (keyer.prefix !== prefix) throw new Error(`moves: ${work} was keyed with prefix ${keyer.prefix}, expected ${prefix}`)

  const io = await gltfIO()
  const origDoc = await io.read(charGlb)
  const expDoc = await io.read(join(work, 'moves_blender.glb'))
  const orig = rigOf(origDoc)
  const exp = rigOf(expDoc)
  const joints = origDoc.getRoot().listSkins()[0]!.listJoints().map(j => j.getName())
  const r = retarget(orig, exp, joints)
  const control = controlCheck(orig, exp, r, keyer.controlAction)
  log(`${skel}: control STAND1 ${control.maxRotDeg.toFixed(4)}° ${control.maxTransM.toExponential(2)} m over ${control.samples} samples`)

  const clipNames = Object.keys(keyer.clips).sort()
  const packClips = clipNames.map(clip => ({ anim: keyer.clips[clip]!.action, clip: reexpressClip(r, exp, findAnimation(expDoc, keyer.clips[clip]!.action)) }))
  const packDoc = buildMovementPack(origDoc, `${skel}/movement`, joints, packClips)
  const glb = await io.writeBinary(packDoc)
  const pack = rigOf(await io.readBinary(glb))

  const ground = groundOf(orig)
  const sidecar = JSON.parse(readFileSync(charGlb.replace(/\.glb$/i, '.json'), 'utf8')) as { animations?: { name: string, group: string }[] }
  const index: MovementIndex = { format: 'sro-movement', version: 1, skeleton: skel, pack: packPath(skel), clips: {}, runJumps: {} }
  const report: Omit<MovesReport, 'failures'> = {
    skeleton: skel,
    prefix,
    packBytes: glb.byteLength,
    restReorientDeg: [...new Set(r.reorientDeg.map(d => Math.round(d)))].sort((a, b) => a - b),
    control,
    clips: {},
    runMatches: [],
    playerRuns: playerRuns(sidecar),
  }
  for (const clip of clipNames) {
    const k = keyer.clips[clip]!
    const spec = JSON.parse(readFileSync(join(KEYS_DIR, skel, `${clip}.json`), 'utf8')) as MoveSpec
    const anim = findAnimation(pack.doc, k.action)
    const run = k.run ? runTrack(orig, k.run, ground) : null
    const c = checkClip(pack, anim, ground, k, spec, run)
    c.maxVsExportM = packVsExport(pack, anim, exp, findAnimation(expDoc, k.action), r)
    report.clips[clip] = c
    const entry: MovementClipIndex = {
      anim: k.action,
      durationMs: c.durationMs,
      fps: FPS,
      frames: c.frames,
      takeoffMs: k.takeoffMs,
      touchMs: k.touchMs,
      events: k.events.map(e => ({ timeMs: e.timeMs, type: 2, p1: e.type as MovementEvent['p1'], p2: 0 })),
      air: c.air,
    }
    if (k.run) {
      Object.assign(entry, {
        run: k.run,
        runCycleS: k.runCycleS,
        enterPhaseS: k.enterPhaseS ?? 0,
        exitPhaseS: k.exitPhaseS ?? 0,
        for: k.for ?? [k.run],
        blendFor: k.blendFor ?? [],
      })
      for (const rn of [...entry.for!, ...entry.blendFor!]) {
        if (index.runJumps[rn]) throw new Error(`moves: ${rn} is served by both ${index.runJumps[rn]} and ${k.kind}`)
        index.runJumps[rn] = k.kind
      }
      report.runMatches.push(...runMatches(orig, pack, anim, k, ground))
    }
    index.clips[k.kind] = entry
    log(`${skel}: ${k.kind} ${c.anim} ${c.frames} fr ${c.durationMs} ms, ${c.channels} ch, ${c.rawBytes} B, planted ${(c.maxPlantedM * 1000).toFixed(2)} mm, `
      + `slide ${(c.maxSlideM * 1000).toFixed(1)} mm, air ≥ ${c.minAirM.toFixed(4)} m, root ${c.rootExcursionM.toFixed(3)}/${c.rootEndsM.toFixed(3)} m, `
      + `vs export ${c.maxVsExportM.toExponential(2)} m`)
  }
  for (const m of report.runMatches) log(`${skel}: ${m.kind} vs ${m.run}${m.blend ? ' (blend)' : ''}: feet ${(m.enterM * 100).toFixed(2)} / ${(m.exitM * 100).toFixed(2)} cm`)
  const full: MovesReport = { ...report, failures: failuresOf(report, index) }

  const write = (file: string, data: Uint8Array | string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  write(join(outRoot, ...packPath(skel).split('/')), glb)
  write(join(outRoot, ...indexPath(skel).split('/')), `${JSON.stringify(index, null, 1)}\n`)
  write(join(work, 'roundtrip.json'), `${JSON.stringify(full, null, 1)}\n`)
  log(`${skel}: wrote ${packPath(skel)} (${glb.byteLength} B) and ${indexPath(skel)}; ${full.failures.length} failed checks`)
  for (const f of full.failures) log(`  FAIL ${f}`)
  return { index, report: full }
}

/** `pnpm sro moves …`: returns the process exit code. */
export async function exportMovesCli(args: readonly string[], cfg: SroConfig): Promise<number> {
  // the town clips (TOWN_LIFE §3.1, lane TL-A2) share the verb and the keyer's pipeline
  if (args.includes('--town')) return (await import('./town-clips.ts')).townClipsCli(args, cfg)
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const abs = (p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : resolve(REPO_ROOT, p))
  const skels = (opt('--skel')?.split(',') ?? Object.keys(MOVE_SKELETONS)) as MoveSkeleton[]
  for (const s of skels) {
    if (!(s in MOVE_SKELETONS)) {
      console.error(`moves: unknown skeleton ${s}; expected ${Object.keys(MOVE_SKELETONS).join(', ')}`)
      return 1
    }
  }
  let failed = 0
  for (const skel of skels) {
    try {
      const { report } = await exportMoves(skel, {
        outRoot: abs(opt('--out')),
        workRoot: abs(opt('--work')),
        key: !args.includes('--no-key'),
        cfg,
        log: line => console.log(line),
      })
      failed += report.failures.length
    } catch (e) {
      console.error(`moves: ${skel}: ${(e as Error).message}`)
      failed++
    }
  }
  return failed ? 1 : 0
}
