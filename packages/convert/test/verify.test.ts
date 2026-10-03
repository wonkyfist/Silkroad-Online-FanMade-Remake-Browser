/**
 * Adversarial verification of the converter output in work/out (pnpm sro convert --preset m1).
 *
 * Everything here is recomputed from the written glb files with plain CPU glTF semantics (node TRS hierarchy,
 * inverseBindMatrices, LINEAR/slerp sampling), and from the raw client bytes where a second opinion is needed:
 *   1. bind pose: skinning at rest reproduces POSITION, and POSITION/NORMAL equal the raw BMS pushed through space.ts
 *   2. animation sanity: every clip at 10 times: finite, bounded, stand clips upright (against the client's own BSR
 *      collision boxes), bones never stretch; overlay clips (sidecar partial) layer over STAND1
 *   3. handedness: the mesh faces +Z (toes, run-cycle stance foot), 'L' bones and their vertices sit at +X,
 *      and the CCW winding agrees with the stored normals
 *   4. cross-check with an independent third-party conversion (read-only, skipped when the folder is absent)
 *   5. weapon attachment: the attach bone exists on every character; the blade's origin and long axis; the SRO socket rule
 * Skips when sro.config.json or work/out is missing; part 4 also when the reference folder is (SRO_REFERENCE_ASSETS).
 * It checks work/out as it is: re-run `pnpm sro convert --preset m1` after changing the converter.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { NodeIO, type Animation, type Document, type Node } from '@gltf-transform/core'
import { parseBms, parseBsr } from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import type { Sidecar } from '../src/gltf/convert.ts'
import { FLIP_WINDING, toGltfDirection, toGltfPosition, type Quat, type Vec3 } from '../src/gltf/space.ts'

const OUT = join(REPO_ROOT, 'work', 'out')
const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))
const HAS_OUT = existsSync(join(OUT, 'index.json'))
const REFERENCE = process.env.SRO_REFERENCE_ASSETS ??
  '' // set SRO_REFERENCE_ASSETS to an independent conversion's client/assets folder (skipped without it)

const SKINNED = [
  'char/china/chinaman_adventurer', 'char/china/chinawoman_adventurer', 'char/europe/europeman_adventurer',
  'mob/china/mangnyang', 'mob/china/tiger', 'mob/china/tigerwoman',
]
const CHARACTERS = SKINNED.slice(0, 3)
const BLADE = 'item/china/weapon/blade_01'

type Mat4 = number[]

// --- small math (column-major, column vectors, glTF layout) ----------------------------------------------------

function mul(a: ArrayLike<number>, b: ArrayLike<number>): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!
  return out
}

function apply(m: ArrayLike<number>, x: number, y: number, z: number): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}

function trs(q: ArrayLike<number>, t: ArrayLike<number>, s: ArrayLike<number> = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!]
  return [
    (1 - 2 * (y * y + z * z)) * s[0]!, 2 * (x * y + z * w) * s[0]!, 2 * (x * z - y * w) * s[0]!, 0,
    2 * (x * y - z * w) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, 2 * (y * z + x * w) * s[1]!, 0,
    2 * (x * z + y * w) * s[2]!, 2 * (y * z - x * w) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ]
}

function slerp(a: Quat, b: Quat, u: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  let bb = b
  if (d < 0) {
    d = -d
    bb = b.map(c => -c) as Quat
  }
  let wa = 1 - u
  let wb = u
  if (d < 0.9995) {
    const th = Math.acos(Math.min(1, d))
    wa = Math.sin((1 - u) * th) / Math.sin(th)
    wb = Math.sin(u * th) / Math.sin(th)
  }
  const q = a.map((c, i) => wa * c + wb * bb[i]!) as Quat
  const len = Math.hypot(...q)
  return q.map(c => c / len) as Quat
}

interface Box { min: Vec3; max: Vec3 }
const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
const extent = (b: Box): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
const diag = (b: Box) => Math.hypot(...extent(b))

// --- glTF evaluation ------------------------------------------------------------------------------------------

interface Local { r: Quat; t: Vec3; s: Vec3 }

function restLocals(doc: Document): Map<Node, Local> {
  const m = new Map<Node, Local>()
  for (const n of doc.getRoot().listNodes()) m.set(n, { r: [...n.getRotation()] as Quat, t: [...n.getTranslation()] as Vec3, s: [...n.getScale()] as Vec3 })
  return m
}

function animDuration(anim: Animation): number {
  let d = 0
  for (const s of anim.listSamplers()) {
    const input = s.getInput()!.getArray()!
    d = Math.max(d, input[input.length - 1]!)
  }
  return d
}

/**
 * glTF LINEAR sampling (slerp for rotations), clamped to the sampler's key range. Channels of `anim` override
 * `base` (an overlay clip layered over a base pose), which defaults to the rest pose.
 */
function sampleLocals(doc: Document, anim: Animation | null, time: number, base?: Map<Node, Local>): Map<Node, Local> {
  const locals = base ? new Map([...base].map(([n, l]) => [n, { r: [...l.r] as Quat, t: [...l.t] as Vec3, s: [...l.s] as Vec3 }])) : restLocals(doc)
  if (!anim) return locals
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler()!
    const input = s.getInput()!.getArray()!
    const output = s.getOutput()!.getArray()!
    const path = ch.getTargetPath()
    const size = path === 'rotation' ? 4 : 3
    let k = 0
    while (k + 1 < input.length && input[k + 1]! <= time) k++
    const k1 = Math.min(k + 1, input.length - 1)
    const u = k1 === k ? 0 : Math.min(1, Math.max(0, (time - input[k]!) / (input[k1]! - input[k]!)))
    const a: number[] = Array.from(output.subarray(k * size, k * size + size))
    const b: number[] = Array.from(output.subarray(k1 * size, k1 * size + size))
    const l = locals.get(ch.getTargetNode()!)!
    if (path === 'rotation') l.r = slerp(a as Quat, b as Quat, u)
    else if (path === 'translation') l.t = a.map((c, i) => c + (b[i]! - c) * u) as Vec3
    else if (path === 'scale') l.s = a.map((c, i) => c + (b[i]! - c) * u) as Vec3
  }
  return locals
}

function worldMatrices(doc: Document, locals: Map<Node, Local>): Map<Node, Mat4> {
  const world = new Map<Node, Mat4>()
  const visit = (n: Node, parent: Mat4 | null) => {
    const l = locals.get(n)!
    const m = trs(l.r, l.t, l.s)
    const w = parent ? mul(parent, m) : m
    world.set(n, w)
    for (const c of n.listChildren()) visit(c, w)
  }
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, null)
  return world
}

interface SkinnedPrim { name: string; pos: Float32Array; joints: ArrayLike<number>; weights: ArrayLike<number>; indices: ArrayLike<number>; normals: Float32Array }

function skinnedPrims(doc: Document): SkinnedPrim[] {
  const out: SkinnedPrim[] = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh || !node.getSkin()) continue
    for (const p of mesh.listPrimitives()) {
      out.push({
        name: node.getName(),
        pos: p.getAttribute('POSITION')!.getArray() as Float32Array,
        normals: p.getAttribute('NORMAL')!.getArray() as Float32Array,
        joints: p.getAttribute('JOINTS_0')!.getArray()!,
        weights: p.getAttribute('WEIGHTS_0')!.getArray()!,
        indices: p.getIndices()!.getArray()!,
      })
    }
  }
  return out
}

/** Skinned positions of every skinned primitive (world = sum w * jointWorld * inverseBind * p). */
function skin(doc: Document, world: Map<Node, Mat4>): Float32Array[] {
  const sk = doc.getRoot().listSkins()[0]!
  const ibm = sk.getInverseBindMatrices()!.getArray()!
  const jm = sk.listJoints().map((j, i) => mul(world.get(j)!, ibm.subarray(i * 16, i * 16 + 16)))
  return skinnedPrims(doc).map(p => {
    const res = new Float32Array(p.pos.length)
    for (let v = 0; v < p.pos.length / 3; v++) {
      for (let s = 0; s < 4; s++) {
        const w = p.weights[v * 4 + s]!
        if (!w) continue
        const q = apply(jm[p.joints[v * 4 + s]!]!, p.pos[v * 3]!, p.pos[v * 3 + 1]!, p.pos[v * 3 + 2]!)
        for (let c = 0; c < 3; c++) res[v * 3 + c] += w * q[c]!
      }
    }
    return res
  })
}

function boxOf(arrays: ArrayLike<number>[]): Box {
  const b = emptyBox()
  for (const a of arrays) {
    for (let i = 0; i < a.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        b.min[c] = Math.min(b.min[c]!, a[i + c]!)
        b.max[c] = Math.max(b.max[c]!, a[i + c]!)
      }
    }
  }
  return b
}

const nodeByName = (doc: Document, name: string) => doc.getRoot().listNodes().find(n => n.getName() === name)
const nodePos = (world: Map<Node, Mat4>, n: Node): Vec3 => { const m = world.get(n)!; return [m[12]!, m[13]!, m[14]!] }
const f3 = (v: ArrayLike<number>, d = 3) => `(${Array.from(v).map(x => x.toFixed(d)).join(', ')})`

/** Centroid of the vertices whose dominant influence is `joint` (bind pose). */
function dominantCentroid(doc: Document, joint: Node): Vec3 | null {
  const joints = doc.getRoot().listSkins()[0]!.listJoints()
  const ji = joints.indexOf(joint)
  const acc: Vec3 = [0, 0, 0]
  let n = 0
  for (const p of skinnedPrims(doc)) {
    for (let v = 0; v < p.pos.length / 3; v++) {
      let best = 0
      for (let s = 1; s < 4; s++) if (p.weights[v * 4 + s]! > p.weights[v * 4 + best]!) best = s
      if (p.joints[v * 4 + best] !== ji) continue
      for (let c = 0; c < 3; c++) acc[c] += p.pos[v * 3 + c]!
      n++
    }
  }
  return n ? (acc.map(c => c / n) as Vec3) : null
}

async function readGlb(path: string): Promise<Document> {
  return new NodeIO().readBinary(new Uint8Array(readFileSync(path)))
}

// --- the checks -----------------------------------------------------------------------------------------------

describe.skipIf(!HAS_CONFIG || !HAS_OUT)('verify work/out (m1 preset)', () => {
  const docs = new Map<string, Document>()
  const sidecars = new Map<string, Sidecar>()
  const read = (p: string) => openArchive('Data').read(p)

  beforeAll(async () => {
    for (const id of [...SKINNED, BLADE]) {
      docs.set(id, await readGlb(join(OUT, `${id}.glb`)))
      sidecars.set(id, JSON.parse(readFileSync(join(OUT, `${id}.json`), 'utf8')) as Sidecar)
    }
  })

  it('1. bind pose: skinning at rest reproduces POSITION, which equals the raw BMS through space.ts', () => {
    const rows: string[] = []
    for (const id of SKINNED) {
      const doc = docs.get(id)!
      const sc = sidecars.get(id)!
      const rest = skin(doc, worldMatrices(doc, restLocals(doc)))
      const prims = skinnedPrims(doc)
      let skinErr = 0
      let rawErr = 0
      let normalErr = 0
      let weightErr = 0
      prims.forEach((p, i) => {
        for (let k = 0; k < p.pos.length; k++) skinErr = Math.max(skinErr, Math.abs(rest[i]![k]! - p.pos[k]!))
        for (let v = 0; v < p.pos.length / 3; v++) {
          let s = 0
          for (let j = 0; j < 4; j++) s += p.weights[v * 4 + j]!
          weightErr = Math.max(weightErr, Math.abs(s - 1))
        }
        const bmsPath = sc.meshes.find(m => m.name === p.name)!.bms
        const bms = parseBms(read(bmsPath))
        expect(bms.vertexCount, `${id} ${p.name}`).toBe(p.pos.length / 3)
        for (let v = 0; v < bms.vertexCount; v++) {
          const e = toGltfPosition([bms.positions[v * 3]!, bms.positions[v * 3 + 1]!, bms.positions[v * 3 + 2]!])
          const n = toGltfDirection([bms.normals[v * 3]!, bms.normals[v * 3 + 1]!, bms.normals[v * 3 + 2]!])
          const nl = Math.hypot(...n)
          for (let c = 0; c < 3; c++) {
            rawErr = Math.max(rawErr, Math.abs(e[c]! - p.pos[v * 3 + c]!))
            normalErr = Math.max(normalErr, Math.abs(n[c]! / nl - p.normals[v * 3 + c]!))
          }
        }
      })
      rows.push(`${id.padEnd(34)} |rest skin - POSITION| ${skinErr.toExponential(1)} m  |POSITION - raw| ${rawErr.toExponential(1)} m  |NORMAL - raw| ${normalErr.toExponential(1)}  |sum w - 1| ${weightErr.toExponential(1)}`)
      expect(skinErr, id).toBeLessThan(1e-5)
      expect(rawErr, id).toBeLessThan(1e-6)
      expect(normalErr, id).toBeLessThan(1e-5)
      expect(weightErr, id).toBeLessThan(1e-5)
    }
    console.log(`[verify 1] bind pose\n${rows.join('\n')}`)
  })

  it('2. animation sanity: every clip at 10 times is finite, bounded, and stand clips stay upright', () => {
    const rows: string[] = []
    const bad: string[] = []
    for (const id of SKINNED) {
      const doc = docs.get(id)!
      const sc = sidecars.get(id)!
      const bindBox = boxOf(skinnedPrims(doc).map(p => p.pos))
      const bindH = extent(bindBox)[1]
      const bindD = diag(bindBox)
      // The client's own boxes (BSR collision section, file space -> glTF): box tops are the exported stand-pose tops.
      const clientBoxes = parseBsr(read(sc.source)).collision.boundingBoxes.map(b => ({
        min: toGltfPosition([b.min[0], b.min[1], b.max[2]]), max: toGltfPosition([b.max[0], b.max[1], b.min[2]]),
      }))
      const clientTop = Math.max(...clientBoxes.map(b => b.max[1]))
      const joints = doc.getRoot().listSkins()[0]!.listJoints()
      const rootJoints = new Set(joints.filter(j => !joints.includes(j.getParentNode() as Node)))
      // Joints that carry geometry (dominant influence of at least one vertex); weapon anchors like HandMid do not.
      const skinnedJoints = new Set(joints.filter(j => dominantCentroid(doc, j) !== null))
      const lengthRatios: number[] = []
      let worstRatio = 0
      let standMatch = ''
      const partials: string[] = []
      const stand1 = doc.getRoot().listAnimations().find(a => a.getName() === 'STAND1')!
      let worstClip = ''
      let maxStretch = 0
      let stretchWhere = ''
      let maxHemi = 0
      let durationErr = 0
      for (const anim of doc.getRoot().listAnimations()) {
        const name = anim.getName()
        const dur = animDuration(anim)
        const meta = sc.animations.find(a => a.name === name)!
        const channelJoints = new Set(anim.listChannels().map(c => c.getTargetNode()))
        if (meta.trackedJoints === undefined) bad.push(`${id} ${name}: sidecar lacks trackedJoints`)
        else if (meta.partial ? channelJoints.size !== meta.trackedJoints : channelJoints.size !== joints.length) {
          bad.push(`${id} ${name}: ${channelJoints.size} animated joints (partial=${meta.partial ?? false}, tracked ${meta.trackedJoints})`)
        }
        if (meta.partial) partials.push(`${name}(${meta.trackedJoints})`)
        durationErr = Math.max(durationErr, Math.abs(dur * 1000 - meta.durationMs))
        // Bones must not stretch: a non-root joint's animated translation length equals its bind length.
        for (const ch of anim.listChannels()) {
          const node = ch.getTargetNode()!
          const out = ch.getSampler()!.getOutput()!.getArray()!
          if (ch.getTargetPath() === 'rotation') {
            for (let k = 4; k < out.length; k += 4) {
              const d = out[k - 4]! * out[k]! + out[k - 3]! * out[k + 1]! + out[k - 2]! * out[k + 2]! + out[k - 1]! * out[k + 3]!
              maxHemi = Math.max(maxHemi, -d)
            }
          }
          if (ch.getTargetPath() !== 'translation' || rootJoints.has(node) || !skinnedJoints.has(node)) continue
          const bindLen = Math.hypot(...node.getTranslation())
          if (bindLen > 0.05) lengthRatios.push(Math.hypot(out[0]!, out[1]!, out[2]!) / bindLen)
          for (let k = 0; k < out.length; k += 3) {
            const d = Math.abs(Math.hypot(out[k]!, out[k + 1]!, out[k + 2]!) - bindLen)
            if (d > maxStretch) {
              maxStretch = d
              stretchWhere = `${name}/${node.getName()} bind ${bindLen.toFixed(4)} m`
            }
          }
        }
        let clipWorst = 0
        let minH = Infinity
        let maxH = 0
        let minTop = Infinity
        let maxTop = -Infinity
        for (let i = 0; i < 10; i++) {
          const t = (dur * i) / 9
          // Overlay clips are sampled over the STAND1 pose, the way the sidecar says to play them.
          const base = meta.partial ? sampleLocals(doc, stand1, Math.min(t, animDuration(stand1))) : undefined
          const posed = skin(doc, worldMatrices(doc, sampleLocals(doc, anim, t, base)))
          const finite = posed.every(a => a.every(Number.isFinite))
          if (!finite) {
            bad.push(`${id} ${name} t=${t.toFixed(3)}: non-finite vertex`)
            continue
          }
          const box = boxOf(posed)
          const ratio = Math.max(diag(box) / bindD, Math.max(...extent(box)) / Math.max(...extent(bindBox)))
          clipWorst = Math.max(clipWorst, ratio)
          minH = Math.min(minH, extent(box)[1])
          maxH = Math.max(maxH, extent(box)[1])
          minTop = Math.min(minTop, box.max[1])
          maxTop = Math.max(maxTop, box.max[1])
          if (name === 'STAND1' && i === 0) {
            const top = box.max[1]
            standMatch = `STAND1@0 top ${top.toFixed(3)} m vs client box top ${clientTop.toFixed(3)} m`
            if (id.startsWith('mob/') && Math.abs(top - clientTop) > 5e-3) bad.push(`${id}: ${standMatch}`)
            if (id === 'mob/china/tigerwoman') {
              // Her x extent is asymmetric (wand hand), so this also pins handedness against the client's numbers.
              const c = clientBoxes[0]!
              const err = Math.max(...[0, 2].flatMap(k => [Math.abs(box.min[k]! - c.min[k]!), Math.abs(box.max[k]! - c.max[k]!)]))
              standMatch += `, x/z extents vs client box ${err.toExponential(1)} m`
              if (err > 5e-3) bad.push(`${id}: STAND1@0 x/z extents differ from the client box by ${err} m`)
            }
          }
        }
        if (clipWorst > worstRatio) {
          worstRatio = clipWorst
          worstClip = name
        }
        if (clipWorst > 3) bad.push(`${id} ${name}: bbox ${clipWorst.toFixed(2)}x the bind box`)
        // Upright: stand clips keep the top of the model within 20% of the client's stand-pose top (a mob's bind
        // pose is not its stand pose: the tiger's bind is 1.97 m tall, its stand 1.55 m, as in the client box).
        if (/^STAND\d*$/.test(name) && (minTop < 0.8 * clientTop || maxTop > 1.2 * clientTop)) {
          bad.push(`${id} ${name}: top ${minTop.toFixed(3)}-${maxTop.toFixed(3)} m vs client box top ${clientTop.toFixed(3)} m`)
        }
        if (name === 'STAND1') {
          rows.push(`${id.padEnd(34)} STAND1 height ${minH.toFixed(3)}-${maxH.toFixed(3)} m, top ${minTop.toFixed(3)}-${maxTop.toFixed(3)} m (bind height ${bindH.toFixed(3)} m); ${standMatch}`)
        }
      }
      lengthRatios.sort((x, y) => x - y)
      const medianRatio = lengthRatios[lengthRatios.length >> 1]!
      rows.push(`${id.padEnd(34)} ${doc.getRoot().listAnimations().length} clips, worst bbox ${worstRatio.toFixed(2)}x (${worstClip}), ` +
        `animated/bind bone length median ${medianRatio.toFixed(3)}, max skinned-bone stretch ${maxStretch.toFixed(3)} m (${stretchWhere}), ` +
        `max -dot(q_k, q_k+1) ${maxHemi.toFixed(3)}, |duration - sidecar| ${durationErr.toFixed(1)} ms, overlay clips: ${partials.join(' ') || 'none'}`)
      // A translation scale or unit bug would move this far from 1 (tigerwoman's own clips are authored at 0.846).
      if (medianRatio < 0.8 || medianRatio > 1.2) bad.push(`${id}: animated bone lengths are ${medianRatio.toFixed(3)}x the bind lengths`)
      if (maxStretch > 0.1) bad.push(`${id}: bone stretched by ${maxStretch.toFixed(3)} m in ${stretchWhere}`)
      expect(maxHemi, id).toBeLessThanOrEqual(0)
      expect(durationErr, id).toBeLessThan(1.5)
    }
    console.log(`[verify 2] animations\n${rows.join('\n')}`)
    if (bad.length) console.log(`[verify 2] problems:\n${bad.join('\n')}`)
    expect(bad).toEqual([])
  })

  it('2b. overlay clips (DAMAGE1, DEFENCE, STAND3) layer over the stand pose instead of snapping to the bind pose', () => {
    const rows: string[] = []
    for (const id of SKINNED) {
      const doc = docs.get(id)!
      const sc = sidecars.get(id)!
      const stand1 = doc.getRoot().listAnimations().find(a => a.getName() === 'STAND1')!
      for (const meta of sc.animations.filter(a => a.partial)) {
        const anim = doc.getRoot().listAnimations().find(a => a.getName() === meta.name)!
        const t = animDuration(anim) / 2
        const standBox = boxOf(skin(doc, worldMatrices(doc, sampleLocals(doc, stand1, t))))
        const layered = boxOf(skin(doc, worldMatrices(doc, sampleLocals(doc, anim, t, sampleLocals(doc, stand1, t)))))
        // What a self-contained clip (bind pose for every untracked bone) would show: characters T-pose their arms.
        const withRest = boxOf(skin(doc, worldMatrices(doc, sampleLocals(doc, anim, t))))
        const w = (b: Box) => Math.max(extent(b)[0], extent(b)[2])
        rows.push(`${id.padEnd(34)} ${meta.name.padEnd(28)} ${meta.trackedJoints} joints, width ${w(layered).toFixed(3)} m layered / ${w(standBox).toFixed(3)} m STAND1 / ${w(withRest).toFixed(3)} m over the bind pose`)
        expect(w(layered) / w(standBox), `${id} ${meta.name}`).toBeLessThan(1.5)
      }
    }
    expect(sidecars.get('char/china/chinaman_adventurer')!.animations.find(a => a.name === 'DAMAGE1')!.partial).toBe(true)
    expect(sidecars.get('char/china/chinaman_adventurer')!.animations.find(a => a.name === 'RUN')!.partial).toBeUndefined()
    console.log(`[verify 2b] overlay clips\n${rows.join('\n')}`)
  })

  it('3. handedness: faces +Z, L bones and their vertices at +X, winding agrees with the normals', () => {
    const rows: string[] = []
    for (const id of SKINNED) {
      const doc = docs.get(id)!
      const prefix = doc.getRoot().listSkins()[0]!.listJoints()[0]!.getName().split(' ')[0]!
      const n = (s: string) => nodeByName(doc, `${prefix} ${s}`)!
      const rest = worldMatrices(doc, restLocals(doc))
      // Facing from the mesh: the toe vertices lie ahead (+Z) of the foot joint.
      const facing: number[] = []
      for (const side of ['L', 'R']) {
        const toe = dominantCentroid(doc, n(`${side} Toe0`))
        const foot = nodePos(rest, n(`${side} Foot`))
        if (toe) facing.push(toe[2] - foot[2])
      }
      // Facing from motion: in the RUN cycle (in place), the lower (stance) toe slides backwards, i.e. towards -Z.
      const run = doc.getRoot().listAnimations().find(a => a.getName() === 'RUN')!
      const dur = animDuration(run)
      let stanceVz = 0
      let gait = 0
      let rootDz = 0
      const steps = 60
      let prev: { l: Vec3; r: Vec3; root: Vec3 } | null = null
      let first: Vec3 | null = null
      for (let i = 0; i <= steps; i++) {
        const w = worldMatrices(doc, sampleLocals(doc, run, (dur * i) / steps))
        const cur = { l: nodePos(w, n('L Toe0')), r: nodePos(w, n('R Toe0')), root: nodePos(w, n('Pelvis')) }
        first ??= cur.root
        if (prev) {
          // Relative to the hips, so root bob and sway cancel out.
          const low = cur.l[1] < cur.r[1] ? 'l' : 'r'
          gait = Math.max(gait, Math.abs(cur.l[1] - cur.r[1]))
          stanceVz += (cur[low][2] - cur.root[2]) - (prev[low][2] - prev.root[2])
        }
        prev = cur
        rootDz = cur.root[2] - first[2]
      }
      // Left/right: the 'L' limb joints and the vertices they dominate are at +X.
      const lHand = nodePos(rest, n('L Hand'))
      const rHand = nodePos(rest, n('R Hand'))
      const lThigh = dominantCentroid(doc, n('L Thigh'))
      const rThigh = dominantCentroid(doc, n('R Thigh'))
      // Winding: glTF counter-clockwise front faces against the stored vertex normals.
      let agree = 0
      let disagree = 0
      for (const p of skinnedPrims(doc)) {
        for (let t = 0; t < p.indices.length; t += 3) {
          const [a, b, c] = [p.indices[t]! * 3, p.indices[t + 1]! * 3, p.indices[t + 2]! * 3]
          const e1 = [p.pos[b]! - p.pos[a]!, p.pos[b + 1]! - p.pos[a + 1]!, p.pos[b + 2]! - p.pos[a + 2]!]
          const e2 = [p.pos[c]! - p.pos[a]!, p.pos[c + 1]! - p.pos[a + 1]!, p.pos[c + 2]! - p.pos[a + 2]!]
          const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
          let d = 0
          for (const k of [a, b, c]) d += g[0]! * p.normals[k]! + g[1]! * p.normals[k + 1]! + g[2]! * p.normals[k + 2]!
          if (d > 0) agree++
          else if (d < 0) disagree++
        }
      }
      rows.push(`${id.padEnd(34)} toe-foot dz ${facing.map(x => x.toFixed(3)).join('/')} m, RUN stance-toe dz (hip-relative) ${gait > 0.15 ? `${stanceVz.toFixed(3)} m` : 'n/a, feet move together'} (root drift ${rootDz.toFixed(3)} m), L Hand x ${lHand[0].toFixed(3)} / R Hand x ${rHand[0].toFixed(3)}, L/R thigh verts x ${lThigh?.[0].toFixed(3)}/${rThigh?.[0].toFixed(3)}, winding ${agree}:${disagree}`)
      for (const f of facing) expect(f, `${id} toes ahead of the feet`).toBeGreaterThan(0)
      // A hovering creature (tigerwoman: feet together, level with each other all cycle) has no stance phase.
      if (gait > 0.15) expect(stanceVz, `${id} stance foot slides to -Z`).toBeLessThan(0)
      expect(lHand[0], id).toBeGreaterThan(0)
      expect(rHand[0], id).toBeLessThan(0)
      expect(lThigh![0], id).toBeGreaterThan(0)
      expect(rThigh![0], id).toBeLessThan(0)
      expect(agree, id).toBeGreaterThan(20 * Math.max(1, disagree))
    }
    // The blade too (static): same winding rule.
    const blade = docs.get(BLADE)!
    let agree = 0
    let disagree = 0
    for (const mesh of blade.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const pos = p.getAttribute('POSITION')!.getArray()!
        const nor = p.getAttribute('NORMAL')!.getArray()!
        const idx = p.getIndices()!.getArray()!
        for (let t = 0; t < idx.length; t += 3) {
          const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3]
          const e1 = [pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!]
          const e2 = [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!]
          const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
          let d = 0
          for (const k of [a, b, c]) d += g[0]! * nor[k]! + g[1]! * nor[k + 1]! + g[2]! * nor[k + 2]!
          if (d > 0) agree++
          else disagree++
        }
      }
    }
    rows.push(`${BLADE.padEnd(34)} winding ${agree}:${disagree}`)
    expect(agree).toBeGreaterThan(10 * disagree)
    expect(FLIP_WINDING).toBe(true)
    console.log(`[verify 3] handedness (glTF: front +Z, left +X)\n${rows.join('\n')}`)
  })

  it('5. weapon attachment: the attach bone exists on every character, the blade origin sits at its grip', () => {
    const blade = docs.get(BLADE)!
    const sc = sidecars.get(BLADE)!
    expect(sc.attachBone).toBe('Bip01 R HandMid')
    for (const id of CHARACTERS) {
      const bone = nodeByName(docs.get(id)!, sc.attachBone!)
      expect(bone, id).toBeDefined()
      expect(docs.get(id)!.getRoot().listSkins()[0]!.listJoints()).toContain(bone)
    }
    // Principal axis of the blade's vertices (power iteration on the covariance).
    const pts: Vec3[] = []
    for (const mesh of blade.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const pos = p.getAttribute('POSITION')!.getArray()!
        for (let i = 0; i < pos.length; i += 3) pts.push([pos[i]!, pos[i + 1]!, pos[i + 2]!])
      }
    }
    const box = boxOf(pts.map(p => p))
    const mean = [0, 1, 2].map(c => pts.reduce((s, p) => s + p[c]!, 0) / pts.length)
    const cov = [0, 1, 2].map(r => [0, 1, 2].map(c => pts.reduce((s, p) => s + (p[r]! - mean[r]!) * (p[c]! - mean[c]!), 0) / pts.length))
    let axis = [1, 1, 1]
    for (let i = 0; i < 100; i++) {
      const v = [0, 1, 2].map(r => cov[r]!.reduce((s, x, c) => s + x * axis[c]!, 0))
      const l = Math.hypot(...v)
      axis = v.map(x => x / l)
    }
    const tip = nodeByName(blade, 'ai_end')
    const start = nodeByName(blade, 'ai_start')
    const rest = worldMatrices(blade, restLocals(blade))
    console.log(`[verify 5] blade_01 bbox min ${f3(box.min)} max ${f3(box.max)} m, principal axis ${f3(axis)}, ` +
      `ai_start ${start ? f3(nodePos(rest, start)) : '-'} ai_end ${tip ? f3(nodePos(rest, tip)) : '-'}; ` +
      `origin inside the bbox along the axis at ${((0 - box.min[2]) / (box.max[2] - box.min[2]) * 100).toFixed(0)}% of the Z length`)
    // A blade: long along one axis (Z), the grip (origin) near one end, the blade tip at the other.
    expect(Math.abs(axis[2]!)).toBeGreaterThan(0.99)
    expect(extent(box)[2]).toBeGreaterThan(5 * Math.max(extent(box)[0], extent(box)[1]))
    expect(-box.min[2]).toBeLessThan(0.2 * extent(box)[2])
    expect(box.max[2]).toBeGreaterThan(0.5)

    // Attach rule. The native client (per OpenSRO's notes on ABC680/AB5870/AB68C0) hangs the item under the attach bone
    // with only the bone's bind-pose world ROTATION cancelled: item = handWorld(t) * inverse(rot(handBindWorld)) * v.
    // Items are therefore authored as if gripped in the T-pose (blade pointing forward). Check it against the data:
    // at every hit event (type 1) of chinaman's sword ATTACK/SKILL clips the blade tip must be in front of the body
    // (glTF +Z = facing) and not pointing into the ground. The naive "item axes = bone axes" attach fails this.
    const man = docs.get('char/china/chinaman_adventurer')!
    const hand = nodeByName(man, sc.attachBone!)!
    const pelvis = nodeByName(man, 'Bip01 Pelvis')!
    const bindHand = worldMatrices(man, restLocals(man)).get(hand)!
    const cancel: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) cancel[c * 4 + r] = bindHand[r * 4 + c]!
    const tipLocal: Vec3 = [mean[0]!, mean[1]!, box.max[2]]
    const sidecarAnims = sidecars.get('char/china/chinaman_adventurer')!.animations
    const strikes = sidecarAnims.filter(a => a.group === 'sword' && /^(ATTACK|SKILL)/.test(a.name))
    const tally = { socket: 0, bone: 0 }
    let events = 0
    for (const a of strikes) {
      const anim = man.getRoot().listAnimations().find(x => x.getName() === a.name)!
      for (const e of (a.events ?? []).filter(e => e.type === 1)) {
        const w = worldMatrices(man, sampleLocals(man, anim, e.timeMs / 1000))
        const hip = nodePos(w, pelvis)
        events++
        for (const [key, m] of [['socket', mul(w.get(hand)!, cancel)], ['bone', w.get(hand)!]] as const) {
          const tip = apply(m, ...tipLocal)
          if (tip[2] - hip[2] > 0.25 && tip[1] > 0.3) tally[key]++
        }
      }
    }
    console.log(`[verify 5] chinaman sword strikes: ${strikes.length} clips, ${events} hit events; blade tip in front of the body ` +
      `and above the ground at ${tally.socket}/${events} with the SRO socket rule vs ${tally.bone}/${events} with bone-axes attach`)
    expect(events).toBeGreaterThan(20)
    expect(tally.socket).toBeGreaterThan(tally.bone)

    // Grip geometry (pose-independent, evaluated at bind): in a hammer grip the handle crosses the palm at right angles
    // to the fingers and the blade leaves the fist on the index/thumb side. Finger1 = index, Finger2 = outer finger.
    const manRest = worldMatrices(man, restLocals(man))
    const at = (name: string) => nodePos(manRest, nodeByName(man, name)!)
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
    const fingers = unit(sub(at('Bip01 R Finger1'), at('Bip01 R Hand')))
    const across = sub(at('Bip01 R Finger1'), at('Bip01 R Finger2'))
    const indexSide = unit(sub(across, fingers.map(x => x * dot(across, fingers)) as Vec3))
    const bladeDir = (m: Mat4) => unit(sub(apply(m, ...tipLocal), apply(m, 0, 0, 0)))
    const grip = (m: Mat4) => { const d = bladeDir(m); return { alongFingers: dot(d, fingers), towardIndex: dot(d, indexSide) } }
    const g = { socket: grip(mul(bindHand, cancel)), bone: grip(bindHand) }
    console.log(`[verify 5] grip at bind: socket along-fingers ${g.socket.alongFingers.toFixed(2)} toward-index ${g.socket.towardIndex.toFixed(2)}; ` +
      `bone-axes along-fingers ${g.bone.alongFingers.toFixed(2)} toward-index ${g.bone.towardIndex.toFixed(2)}`)
    expect(Math.abs(g.socket.alongFingers)).toBeLessThan(0.5)
    expect(g.socket.towardIndex).toBeGreaterThan(0.7)
  })
})

// --- 4: independent conversion (third-party browser port; read-only reference, never copied) ------------------

interface RefGltf {
  json: {
    nodes: Array<{ name?: string; children?: number[]; rotation?: number[]; translation?: number[]; scale?: number[]; mesh?: number; skin?: number }>
    skins?: Array<{ joints: number[] }>
    animations?: Array<{ name?: string; samplers: Array<{ input: number }> }>
    accessors: Array<{ count: number; min?: number[]; max?: number[] }>
    meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>
    scenes?: Array<{ nodes: number[] }>
  }
}

function readGlbJson(path: string): RefGltf['json'] {
  const b = readFileSync(path)
  const len = b.readUInt32LE(12)
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8')) as RefGltf['json']
}

describe.skipIf(!HAS_OUT || !existsSync(REFERENCE))('4. cross-check against an independent conversion', () => {
  const pairs: Array<[string, string]> = [
    ['char/china/chinaman_adventurer', 'characters/chinaman_adventurer/base.glb'],
    ['char/china/chinawoman_adventurer', 'characters/chinawoman_adventurer/base.glb'],
    ['char/europe/europeman_adventurer', 'characters/europeman_adventurer/base.glb'],
    ['mob/china/tiger', 'models/tiger.glb'],
    ['mob/china/tigerwoman', 'models/tigerwoman.glb'],
    ['mob/china/mangnyang', 'models/mangnyang.glb'],
    [BLADE, 'items/weapons/blade_01.glb'],
  ]

  it('joints, vertex counts, height and facing agree (up to the reference\'s unit scale)', () => {
    const rows: string[] = []
    for (const [id, refPath] of pairs) {
      const path = join(REFERENCE, refPath)
      if (!existsSync(path)) {
        rows.push(`${id}: no reference file`)
        continue
      }
      const ref = readGlbJson(path)
      const ours = readGlbJson(join(OUT, `${id}.glb`))
      const jointNames = (j: RefGltf['json']) => (j.skins?.[0]?.joints ?? []).map(i => j.nodes[i]!.name ?? '')
      const verts = (j: RefGltf['json']) => (j.meshes ?? []).reduce((s, m) => s + m.primitives.reduce((t, p) => t + j.accessors[p.attributes.POSITION!]!.count, 0), 0)
      const yExtent = (j: RefGltf['json']) => {
        let lo = Infinity
        let hi = -Infinity
        let zlo = Infinity
        let zhi = -Infinity
        for (const m of j.meshes ?? []) for (const p of m.primitives) {
          const a = j.accessors[p.attributes.POSITION!]!
          lo = Math.min(lo, a.min![1]!)
          hi = Math.max(hi, a.max![1]!)
          zlo = Math.min(zlo, a.min![2]!)
          zhi = Math.max(zhi, a.max![2]!)
        }
        return { h: hi - lo, zlo, zhi }
      }
      const rj = jointNames(ref)
      const oj = jointNames(ours)
      const missing = oj.filter(n => !rj.includes(n))
      const extra = rj.filter(n => !oj.includes(n))
      const ry = yExtent(ref)
      const oy = yExtent(ours)
      const scale = oy.h / ry.h
      const durs = (j: RefGltf['json']) => (j.animations ?? []).map(a => Math.max(...a.samplers.map(s => j.accessors[s.input]!.max?.[0] ?? 0)))
      rows.push(`${id.padEnd(34)} joints ${oj.length}/${rj.length}${missing.length ? ` (ref lacks ${missing.join(',')})` : ''}${extra.length ? ` (ref adds ${extra.join(',')})` : ''}, ` +
        `verts ${verts(ours)}/${verts(ref)}, height ${oy.h.toFixed(3)} m / ${ry.h.toFixed(3)} ref units (x${scale.toFixed(4)}), ` +
        `z range ours ${oy.zlo.toFixed(2)}..${oy.zhi.toFixed(2)} ref ${(ry.zlo * scale).toFixed(2)}..${(ry.zhi * scale).toFixed(2)}, ` +
        `clips ${ours.animations?.length ?? 0}/${ref.animations?.length ?? 0} (ref durations ${durs(ref).map(d => d.toFixed(2)).slice(0, 6).join(',')}...)`)
      expect(verts(ours), id).toBe(verts(ref))
      if (rj.length) expect(missing, id).toEqual([])
      // Same facing: the z range (head/toes vs tail/cloak) must not be mirrored.
      expect(Math.abs(oy.zlo - ry.zlo * scale), id).toBeLessThan(0.02 * oy.h + 0.01)
      expect(Math.abs(oy.zhi - ry.zhi * scale), id).toBeLessThan(0.02 * oy.h + 0.01)
    }
    console.log(`[verify 4] ours / reference\n${rows.join('\n')}`)
  })

  it('bind geometry matches the reference: positions x0.1, normals, uvs, triangle winding', async () => {
    const rows: string[] = []
    for (const [id, refPath] of pairs) {
      const path = join(REFERENCE, refPath)
      if (!existsSync(path)) continue
      const prims = (doc: Document) => doc.getRoot().listMeshes().flatMap(m => m.listPrimitives())
      const ref = prims(await readReference(path))
      const ours = prims(await readGlb(join(OUT, `${id}.glb`)))
      let pos = 0
      let nor = 0
      let uv = 0
      let sameWinding = 0
      let flipped = 0
      let paired = 0
      for (const rp of ref) {
        const rpos = rp.getAttribute('POSITION')!.getArray()!
        const op = ours.find(o => {
          const a = o.getAttribute('POSITION')!.getArray()!
          return a.length === rpos.length && [0, 1, 2].every(c => Math.abs(a[c]! - rpos[c]! * 0.1) < 1e-4)
        })
        if (!op) continue
        paired++
        const opos = op.getAttribute('POSITION')!.getArray()!
        for (let i = 0; i < opos.length; i++) pos = Math.max(pos, Math.abs(opos[i]! - rpos[i]! * 0.1))
        const rn = rp.getAttribute('NORMAL')?.getArray()
        const on = op.getAttribute('NORMAL')!.getArray()!
        if (rn) for (let i = 0; i < on.length; i += 3) nor = Math.max(nor, Math.hypot(on[i]! - rn[i]!, on[i + 1]! - rn[i + 1]!, on[i + 2]! - rn[i + 2]!))
        const ruv = rp.getAttribute('TEXCOORD_0')?.getArray()
        const ouv = op.getAttribute('TEXCOORD_0')!.getArray()!
        if (ruv) for (let i = 0; i < ouv.length; i++) uv = Math.max(uv, Math.abs(ouv[i]! - ruv[i]!))
        // Same triangle, same cyclic order = same front face.
        const key = (a: number, b: number, c: number) => {
          const m = Math.min(a, b, c)
          return m === a ? `${a},${b},${c}` : m === b ? `${b},${c},${a}` : `${c},${a},${b}`
        }
        const oi = op.getIndices()!.getArray()!
        const ourTris = new Set<string>()
        for (let t = 0; t < oi.length; t += 3) ourTris.add(key(oi[t]!, oi[t + 1]!, oi[t + 2]!))
        const ri = rp.getIndices()!.getArray()!
        for (let t = 0; t < ri.length; t += 3) {
          if (ourTris.has(key(ri[t]!, ri[t + 1]!, ri[t + 2]!))) sameWinding++
          else if (ourTris.has(key(ri[t]!, ri[t + 2]!, ri[t + 1]!))) flipped++
        }
      }
      rows.push(`${id.padEnd(34)} ${paired}/${ref.length} primitives paired, max |pos - ref*0.1| ${pos.toExponential(1)} m, ` +
        `max |normal - ref| ${nor.toExponential(1)}, max |uv - ref| ${uv.toExponential(1)}, triangles same winding ${sameWinding}, flipped ${flipped}`)
      expect(paired, id).toBe(ref.length)
      expect(pos, id).toBeLessThan(1e-5)
      expect(uv, id).toBeLessThan(1e-5)
      expect(flipped, id).toBe(0)
    }
    console.log(`[verify 4] bind geometry vs reference\n${rows.join('\n')}`)
  })

  it('posed skinning of every reference clip matches one of ours (x0.1)', async () => {
    const rows: string[] = []
    for (const [id, refPath] of pairs.filter(p => p[0] !== BLADE)) {
      const path = join(REFERENCE, refPath)
      if (!existsSync(path)) continue
      const ref = await readReference(path)
      const ours = await readGlb(join(OUT, `${id}.glb`))
      // Pair primitives by node name, else by vertex count (the reference renames mob mesh nodes).
      const refPrims = skinnedPrims(ref)
      const ourPrims = skinnedPrims(ours)
      const pairIdx = refPrims.map(rp => {
        const byName = ourPrims.findIndex(op => op.name === rp.name)
        if (byName >= 0) return byName
        return ourPrims.findIndex(op => op.pos.length === rp.pos.length &&
          [0, 1, 2].every(c => Math.abs(op.pos[c]! - rp.pos[c]! * 0.1) < 1e-4))
      })
      expect(pairIdx, id).not.toContain(-1)
      const posedError = (ra: Animation, oa: Animation | null, dur: number): number => {
        let err = 0
        for (const u of [0, 0.25, 0.5, 0.75, 1]) {
          const r = skin(ref, worldMatrices(ref, sampleLocals(ref, ra, u * dur)))
          const o = skin(ours, worldMatrices(ours, sampleLocals(ours, oa, u * dur)))
          r.forEach((rp, i) => {
            const op = o[pairIdx[i]!]!
            for (let k = 0; k < rp.length; k += 3) {
              err = Math.max(err, Math.hypot(rp[k]! * 0.1 - op[k]!, rp[k + 1]! * 0.1 - op[k + 1]!, rp[k + 2]! * 0.1 - op[k + 2]!))
            }
          })
          if (err > 0.05) return err
        }
        return err
      }
      const matched: string[] = []
      const unmatched: string[] = []
      for (const ra of ref.getRoot().listAnimations()) {
        const dur = animDuration(ra)
        let best = Infinity
        let bestName = ''
        for (const oa of ours.getRoot().listAnimations()) {
          if (Math.abs(animDuration(oa) - dur) > 0.002) continue
          const e = posedError(ra, oa, dur)
          if (e < best) {
            best = e
            bestName = oa.getName()
          }
        }
        if (best < 0.01) matched.push(`${ra.getName()}=${bestName}(${(best * 1000).toFixed(1)}mm)`)
        else unmatched.push(`${ra.getName()}(${dur.toFixed(3)}s${bestName ? `, nearest ${bestName} ${(best * 1000).toFixed(0)}mm` : ''})`)
      }
      rows.push(`${id.padEnd(34)} ${matched.length}/${matched.length + unmatched.length} reference clips reproduced within 1 cm: ${matched.join(' ')}` +
        (unmatched.length ? `\n${' '.repeat(35)}unmatched: ${unmatched.join(' ')}` : ''))
      // Most of the reference's clips are clips we export; a handedness, quaternion or composition bug breaks them all.
      expect(matched.length, id).toBeGreaterThan(unmatched.length)
    }
    console.log(`[verify 4] posed cross-check\n${rows.join('\n')}`)
  })
})

/** Loads a third-party glb for geometry and animation only: textures (KTX2/basisu) and extensions are dropped. */
async function readReference(path: string): Promise<Document> {
  const b = readFileSync(path)
  const jsonLength = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8')) as Record<string, unknown> & { materials?: Array<Record<string, unknown>> }
  for (const key of ['extensionsRequired', 'extensionsUsed', 'textures', 'images', 'samplers']) delete json[key]
  json.materials = (json.materials ?? []).map(m => ({ name: m.name }))
  const bin = b.subarray(20 + jsonLength)
  let js = Buffer.from(JSON.stringify(json), 'utf8')
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'latin1')
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(20 + js.length + bin.length, 8)
  head.writeUInt32LE(js.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16)
  return new NodeIO().readBinary(new Uint8Array(Buffer.concat([head, js, bin])))
}
